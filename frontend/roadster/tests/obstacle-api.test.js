import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { evaluateObstacle } from '../server/obstacle-api.mjs';
import { makeCandidates } from '../server/ramp-search.mjs';
import { runPhysics } from '../server/physics-runner.mjs';
import { assessWall } from '../src/wall-clearance.js';
import { rampPoint } from '../src/track.js';

// Only the input is read from this fixture. Every result below is computed by
// the real evaluateObstacle -> Python solver -> continuous wall-check pipeline.
const { problemSpec: fixtureInput } = JSON.parse(await readFile(
  new URL('../public/examples/physics-ramp-original.json', import.meta.url), 'utf8',
));
const evidence = [];
const verified = [];
let adjustedAt18;

function defaultSpec() {
  return {
    ramp_curve_m: [
      ...Array.from({ length: 17 }, (_, i) => ({ x: -25 + 19 * i / 16, y: 0 })),
      ...Array.from({ length: 128 }, (_, i) => {
        const { position } = rampPoint((i + 1) / 128);
        return { x: position.x, y: position.y };
      }),
    ],
    entry_speed_ms: 22.2,
    car_mass_kg: 1300,
    downforce_capability_n: 150000,
    ground_profile: { type: 'flat', landing_level_m: 0 },
  };
}

const wall = (x, height = 3) => ({ enabled: true, x, height, width: 8, thickness: 0.35 });
const request = (action, x, height = 3) => ({ action, problemSpec: defaultSpec(), wall: wall(x, height), scale: 1 });

async function execute(label, input, options) {
  const original = structuredClone(input);
  const started = performance.now();
  try {
    const result = await evaluateObstacle(input, options);
    evidence.push({ label, input: original, result, durationMs: performance.now() - started });
    assert.deepEqual(input, original, 'API must preserve caller input');
    return result;
  } catch (error) {
    evidence.push({ label, input: original, error: { name: error.name, code: error.code, message: error.message }, durationMs: performance.now() - started });
    assert.deepEqual(input, original, 'rejection must preserve caller input');
    throw error;
  }
}

function assertLive(envelope) {
  assert.equal(envelope.result.status, 'ok');
  assert.equal(envelope.result.error, null);
  assert.match(envelope.result.execution.sandbox_id, /^local-live-/);
  assert.ok(envelope.result.trajectory.length > 2);
  for (const key of ['entry_speed_ms', 'car_mass_kg', 'downforce_capability_n']) {
    assert.equal(envelope.problemSpec[key], fixtureInput[key], `${key} must stay unchanged`);
  }
  assert.deepEqual(envelope.problemSpec.ground_profile, fixtureInput.ground_profile);
}

function assertAdjusted(result) {
  assertLive(result.before);
  assertLive(result.after);
  assert.equal(result.before.assessment.status, 'collision');
  assert.equal(result.after.assessment.status, 'clear');
  assert.equal(result.after.result.metrics.traction_ok, true);
  assert.equal(result.search.status, 'found');
  assert.ok(result.search.evaluated > 0);
  assert.ok(result.search.feasible > 0);
  assert.notDeepEqual(result.after.problemSpec.ramp_curve_m, result.before.problemSpec.ramp_curve_m);
  assert.notEqual(result.after.result.execution.sandbox_id, result.before.result.execution.sandbox_id);
}

function assertNoSolution(result) {
  assertLive(result.before);
  assert.equal(result.before.assessment.status, 'collision');
  assert.equal(result.after, null, 'an unverified or colliding candidate must never become after');
  assert.equal(result.search.status, 'no-solution');
  assert.equal(result.search.feasible, 0);
}

test('default input is generated from the current rampPoint geometry', () => {
  assert.deepEqual(defaultSpec(), fixtureInput);
  verified.push('default geometry matches input fixture');
});

test('x=-18 m, height=3 m: real trial collides and real adjustment clears with unchanged physics parameters', async () => {
  const trial = await execute('x=-18/h=3 trial', request('trial', -18));
  assertLive(trial.before);
  assert.equal(trial.before.assessment.status, 'collision');
  assert.equal(trial.after, null);
  assert.equal(trial.search, null);
  const adjusted = await execute('x=-18/h=3 adjust', request('adjust', -18));
  assertAdjusted(adjusted);
  assert.notEqual(trial.before.result.execution.sandbox_id, adjusted.before.result.execution.sandbox_id);
  adjustedAt18 = adjusted.after.problemSpec.ramp_curve_m;
  verified.push('x=-18/h=3 collision -> clear, real rerun, unchanged speed/mass/downforce');
});

test('moving the wall to x=-12 m finds a different freshly solved clear curve', async () => {
  assert.ok(adjustedAt18, 'the x=-18 result must be available for comparison');
  const adjusted = await execute('x=-12/h=3 adjust', request('adjust', -12));
  assertAdjusted(adjusted);
  assert.notDeepEqual(adjusted.after.problemSpec.ramp_curve_m, adjustedAt18);
  verified.push('x=-12/h=3 clear with a wall-dependent different curve');
});

test('x=-15 m rejects every candidate, including a traction-safe ramp that hits the wall again in flight', async () => {
  const input = request('adjust', -15);
  const result = await execute('x=-15/h=3 adjust', input);
  assertNoSolution(result);
  assert.ok(result.search.evaluated > 0, 'the no-solution result must include actual candidate evaluations');

  // The first screened candidate clears the road surface and holds traction.
  // Its independently rerun full motion still returns through the wall in flight.
  const [candidate] = makeCandidates(input.problemSpec, input.wall);
  assert.ok(candidate);
  assert.equal(candidate.adjustment.roadClearance.clear, true);
  const [candidateResult] = await runPhysics([candidate.problemSpec]);
  const envelope = { problemSpec: candidate.problemSpec, result: candidateResult };
  const assessment = assessWall(envelope, input.wall, { scale: input.scale });
  evidence.push({ label: 'x=-15/h=3 flight return witness', wall: input.wall, ...envelope, assessment });
  assertLive(envelope);
  assert.equal(candidateResult.metrics.traction_ok, true);
  assert.equal(assessment.status, 'collision');
  assert.equal(assessment.firstHit.phase, 'flight');
  verified.push('x=-15/h=3 no solution; live flight return collision witness');
});

test('x=-24 m overlaps the starting car and cannot be presented as a solved adjustment', async () => {
  const result = await execute('x=-24/h=3 adjust', request('adjust', -24));
  assertNoSolution(result);
  assert.equal(result.before.assessment.firstHit.t, 0);
  verified.push('x=-24/h=3 starting overlap remains no solution');
});

test('x=-18 m, height=25 m has no feasible energy-limited adjustment', async () => {
  const result = await execute('x=-18/h=25 adjust', request('adjust', -18, 25));
  assertNoSolution(result);
  verified.push('x=-18/h=25 no solution without increasing speed/mass/downforce');
});

test('invalid wall dimensions and scale are rejected instead of being solved or clamped', async () => {
  for (const patch of [{ x: -36 }, { x: NaN }, { height: 0 }, { height: 26 }, { width: 9 }, { thickness: 0.4 }, { enabled: false }]) {
    const input = request('adjust', -18);
    Object.assign(input.wall, patch);
    await assert.rejects(execute(`invalid wall: ${Object.keys(patch)[0]}`, input), { code: 'invalid_input' });
  }
  const input = request('adjust', -18);
  input.scale = 0.4;
  await assert.rejects(execute('invalid car scale', input), { code: 'invalid_input' });
  verified.push('invalid wall and scale rejected');
});

test('aborting an active real API calculation rejects without returning a result', async () => {
  const controller = new AbortController();
  const pending = execute('active API abort', request('adjust', -18), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  verified.push('active real calculation aborted');
});

after(async () => {
  const sourceHashes = {};
  for (const path of ['server/obstacle-api.mjs', 'server/ramp-search.mjs', 'server/physics-runner.mjs', 'server/vendor/physics_solver.py', 'src/wall-clearance.js']) {
    sourceHashes[path] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex');
  }
  const path = new URL('../output/wall-avoidance-spike/api-tests-summary.json', import.meta.url);
  await mkdir(new URL('.', path), { recursive: true });
  await writeFile(path, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: 'Direct evaluateObstacle API function with live Python processes and continuous wall assessment; no HTTP or browser claim.',
    sourceHashes, verified, evidence,
  }, null, 2));
});
