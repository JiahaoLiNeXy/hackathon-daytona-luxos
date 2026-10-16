import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runPhysics } from '../server/physics-runner.mjs';

function spec() {
  return {
    ramp_curve_m: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 8, y: 3 }],
    entry_speed_ms: 22.2,
    car_mass_kg: 1300,
    downforce_capability_n: 100_000,
    ground_profile: { type: 'flat', landing_level_m: 0 },
  };
}

test('real batch solves changed curves dynamically in one process and preserves original COM samples', async () => {
  const original = spec();
  const adjusted = spec();
  adjusted.ramp_curve_m = [{ x: 0, y: 0 }, { x: 4, y: 2 }, { x: 8, y: 5 }];
  const input = [original, adjusted];
  const snapshot = structuredClone(input);
  const results = await runPhysics(input);
  assert.equal(results.length, 2);
  assert.deepEqual(input, snapshot);
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 'ok');
    assert.equal(result.error, null);
    assert.equal(result.metrics.outcome, 'landed_normal');
    assert.equal(result.metrics.margin_m, null);
    assert.ok(Number.isFinite(result.execution.duration_ms));
    assert.match(result.execution.sandbox_id, /^local-live-[a-f0-9]{32}-\d+$/);
    assert.deepEqual(result.trajectory.slice(0, 3).map(({ x, y }) => ({ x, y })), input[index].ramp_curve_m);
    assert.ok(result.trajectory.every((point, i, points) => i === 0 || point.t > points[i - 1].t));
    assert.equal(result.trajectory[0].t, 0);
  }
  assert.equal(results[0].execution.sandbox_id.replace(/-\d+$/, ''), results[1].execution.sandbox_id.replace(/-\d+$/, ''));
  assert.notEqual(results[0].metrics.launch_angle_deg, results[1].metrics.launch_angle_deg);
  assert.notEqual(results[0].metrics.landing_x_m, results[1].metrics.landing_x_m);
  assert.notDeepEqual(results[0].trajectory, results[1].trajectory);
});

test('lost traction remains a successful dynamic solver result', async () => {
  const input = spec();
  input.ramp_curve_m = [{ x: 0, y: 0 }, { x: 2, y: 0.8 }, { x: 4, y: 2.4 }, { x: 5.2, y: 3.6 }];
  input.downforce_capability_n = 9000;
  const [result] = await runPhysics([input]);
  assert.equal(result.status, 'ok');
  assert.equal(result.metrics.traction_ok, false);
  assert.equal(result.metrics.outcome, 'lost_traction');
  assert.ok(result.trajectory.some(({ phase }) => phase === 'flight'));
});

test('validates the complete batch before spawning and rejects unsupported or unsafe numeric input', async () => {
  const changes = [
    (value) => { value.ramp_curve_m = []; },
    (value) => { value.ramp_curve_m = new Array(1001); },
    (value) => { value.ramp_curve_m = new Array(2); },
    (value) => { value.ramp_curve_m[1].x = Infinity; },
    (value) => { value.ramp_curve_m[1].x = 1001; },
    (value) => { value.ramp_curve_m[1].y = '2'; },
    (value) => { value.ramp_curve_m[1] = { ...value.ramp_curve_m[0] }; },
    (value) => { value.entry_speed_ms = 0; },
    (value) => { value.entry_speed_ms = 101; },
    (value) => { value.car_mass_kg = 99; },
    (value) => { value.car_mass_kg = 10001; },
    (value) => { value.downforce_capability_n = -1; },
    (value) => { value.downforce_capability_n = 10000001; },
    (value) => { value.ground_profile.type = 'gap'; },
    (value) => { value.ground_profile.landing_level_m = NaN; },
    (value) => { value.ground_profile.landing_level_m = -1001; },
    (value) => { value.ground_profile = null; },
  ];
  for (const change of changes) {
    const invalid = spec();
    change(invalid);
    await assert.rejects(runPhysics([spec(), invalid]), { code: 'invalid_input' });
  }
  for (const input of [null, {}, [], new Array(2), new Array(129)]) {
    await assert.rejects(runPhysics(input), { code: 'invalid_input' });
  }
  await assert.rejects(runPhysics([spec()], { signal: {} }), { code: 'invalid_input' });
});

test('snapshots input synchronously and ignores client code, executable, and environment fields', async () => {
  const input = [spec()];
  input[0].code = 'raise RuntimeError("client supplied code must never run")';
  input[0].executable = 'not-a-python-command';
  input[0].env = { PATH: '' };
  const promise = runPhysics(input);
  input[0].ramp_curve_m[0].x = 999;
  input.push(spec());
  const [result] = await promise;
  assert.equal(result.status, 'ok');
  assert.equal(result.trajectory[0].x, 0);
});

test('an already aborted request never starts and active cancellation terminates its child', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(runPhysics([spec()], { signal: before.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
  const active = new AbortController();
  const pending = runPhysics(Array.from({ length: 128 }, spec), { signal: active.signal });
  active.abort();
  await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  // The runner only rejects after the child close event; a later real solve proves
  // cancellation did not poison shared process/global state.
  assert.equal((await runPhysics([spec()]))[0].status, 'ok');
});

test('rejects a solver result outside the upstream forward-landing sanity boundary', async () => {
  const input = spec();
  input.ramp_curve_m = [{ x: 0, y: 0 }, { x: -4, y: 1 }];
  await assert.rejects(runPhysics([input]), { code: 'result_sanity_check_failed' });
});

test('enforces the stdout budget on a real large batch and remains usable afterward', async () => {
  const input = spec();
  input.ramp_curve_m = Array.from({ length: 1000 }, (_, x) => ({ x, y: 1000 }));
  input.entry_speed_ms = 100;
  input.ground_profile.landing_level_m = -1000;
  await assert.rejects(runPhysics(Array.from({ length: 128 }, () => input)), { code: 'solver_output_limit' });
  assert.equal((await runPhysics([spec()]))[0].status, 'ok');
});

test('the packaged solver hash matches its recorded provenance', async () => {
  const solver = await readFile(new URL('../server/vendor/physics_solver.py', import.meta.url));
  const source = await readFile(new URL('../server/vendor/SOURCE.md', import.meta.url), 'utf8');
  const hash = createHash('sha256').update(solver).digest('hex');
  assert.ok(source.includes(`Vendored \`physics_solver.py\` SHA-256: \`${hash}\``));
  assert.match(source, /No tracked LICENSE, COPYING, or NOTICE/);
  assert.match(source, /0c2a4f2b155afefdaf33c60c86a84d5cd3c7dcd2e4a44ed279beb696ac56ac2a/);
});
