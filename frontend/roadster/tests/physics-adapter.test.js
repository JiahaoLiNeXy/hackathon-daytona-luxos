import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { adaptPhysicsResult } from '../src/physics-adapter.js';
import { sampleTrajectory } from '../src/trajectory.js';

function fixture() {
  return {
    problemSpec: {
      ramp_curve_m: [{ x: 11, y: -3 }, { x: 14, y: -1 }],
      entry_speed_ms: 20,
      car_mass_kg: 1300,
      downforce_capability_n: 9000,
      ground_profile: { type: 'gap', landing_level_m: -4, gap_start_x_m: 14, gap_end_x_m: 20 },
    },
    result: {
      status: 'ok',
      trajectory: [
        { t: 8, x: 11, y: -3, vx: 12, vy: 4, phase: 'ramp' },
        { t: 8.5, x: 14, y: -1, vx: 10, vy: 10, phase: 'ramp' },
        { t: 10, x: 29, y: -4, vx: 10, vy: -12, phase: 'flight' },
      ],
      metrics: {
        traction_ok: true, max_required_downforce_n: 7400, launch_angle_deg: 45,
        launch_speed_ms: Math.sqrt(200), hang_time_s: 1.5, max_height_m: 3,
        landing_x_m: 29, outcome: 'cleared', margin_m: 9,
      },
      execution: { duration_ms: 340, sandbox_id: 'local-test-output' },
      error: null,
    },
  };
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should equal ${expected}`);
}

function facing(trajectory, t) {
  return new Vector3(1, 0, 0).applyQuaternion(sampleTrajectory(trajectory, t).quaternion).toArray();
}

test('maps raw COM coordinates without offsets, axis changes, or resampling', () => {
  const input = fixture();
  const adapted = adaptPhysicsResult(input);
  assert.deepEqual(adapted.trajectory.samples.map(({ position }) => position), [[11, -3, 0], [14, -1, 0], [29, -4, 0]]);
  assert.equal(adapted.trajectory.samples.length, input.result.trajectory.length);
  assert.equal(adapted.trajectory.source, 'physics');
  assert.match(adapted.trajectory.label, /Physics Agent.*cleared/);
  assert.match(adapted.warnings.join(' '), /not a physically solved orientation/);
  assert.match(adapted.warnings.join(' '), /center-of-mass.*does not solve tire-surface/);
  assert.deepEqual(adapted.trajectory.warnings, adapted.warnings);
});

test('normalizes trajectory and phase times by the same original time offset', () => {
  const { trajectory, phases } = adaptPhysicsResult(fixture());
  assert.equal(trajectory.timeOffset, 8);
  assert.equal(trajectory.duration, 2);
  assert.deepEqual(trajectory.samples.map(({ t }) => t), [0, 0.5, 2]);
  assert.deepEqual(phases, [{ t: 0, phase: 'ramp' }, { t: 0.5, phase: 'ramp' }, { t: 2, phase: 'flight' }]);
});

test('visual heading follows reported velocity even when the sampled path differs', () => {
  const input = fixture();
  input.result.trajectory[0].vx = -4;
  input.result.trajectory[0].vy = 3;
  const { trajectory } = adaptPhysicsResult(input);
  facing(trajectory, 0).forEach((component, index) => near(component, [-0.8, 0.6, 0][index]));
  const expected = Math.atan2(3, -4) / 2;
  near(trajectory.samples[0].quaternion[2], Math.sin(expected));
  near(trajectory.samples[0].quaternion[3], Math.cos(expected));
});

test('zero speed holds the last valid heading and vertical velocity stays vertical', () => {
  const input = fixture();
  input.result.trajectory = [
    { t: 0, x: 11, y: -3, vx: 0, vy: 0, phase: 'ramp' },
    { t: 1, x: 11, y: -1, vx: 0, vy: 2, phase: 'ramp' },
    { t: 2, x: 11, y: -1, vx: 0, vy: 0, phase: 'flight' },
    { t: 3, x: 11, y: -4, vx: 0, vy: -2, phase: 'flight' },
  ];
  const { trajectory } = adaptPhysicsResult(input);
  [[1, 0, 0], [0, 1, 0], [0, 1, 0], [0, -1, 0]].forEach((expected, t) => {
    facing(trajectory, t).forEach((component, index) => near(component, expected[index]));
  });
});

test('accepts all four outcomes, including a successful response describing lost traction', () => {
  for (const outcome of ['cleared', 'fell_short', 'landed_normal', 'lost_traction']) {
    const input = fixture();
    input.result.metrics.outcome = outcome;
    input.result.metrics.traction_ok = outcome !== 'lost_traction';
    input.result.metrics.margin_m = outcome === 'fell_short' ? -9 : outcome === 'cleared' ? 9 : null;
    assert.deepEqual(adaptPhysicsResult(input).metrics, input.result.metrics);
  }
});

test('accepts all ground types with their supplied landing level', () => {
  for (const type of ['flat', 'gap', 'lower_level']) {
    const input = fixture();
    input.problemSpec.ground_profile.type = type;
    if (type !== 'gap') {
      delete input.problemSpec.ground_profile.gap_start_x_m;
      delete input.problemSpec.ground_profile.gap_end_x_m;
    }
    assert.deepEqual(adaptPhysicsResult(input).problemSpec, input.problemSpec);
  }
});

test('backend errors preserve code and message before validating successful-result fields', () => {
  for (const code of ['invalid_input', 'sandbox_execution_failed', 'result_sanity_check_failed']) {
    const input = { result: { status: 'error', trajectory: [], metrics: null, error: { code, message: 'A precise backend reason' } } };
    const original = structuredClone(input);
    assert.throws(() => adaptPhysicsResult(input), (error) => error.message.includes(code) && error.message.includes('A precise backend reason'));
    assert.deepEqual(input, original);
  }
});

test('requires the caller to supply the problem geometry and rejects malformed status/error envelopes', () => {
  for (const input of [undefined, null, [], {}, { result: null }, { result: { status: 'pending' } }, { result: fixture().result }]) {
    assert.throws(() => adaptPhysicsResult(input), /Invalid physics result/);
  }
  const input = fixture();
  input.result.error = { code: 'invalid_input', message: 'Contradictory response' };
  assert.throws(() => adaptPhysicsResult(input), /error must be empty/);
});

test('rejects invalid sample fields, phases, counts, and nonincreasing or unrepresentable times', () => {
  const changes = [
    (input) => { input.result.trajectory = []; },
    (input) => { input.result.trajectory.length = 1; },
    (input) => { input.result.trajectory = new Array(2); },
    (input) => { input.result.trajectory[1] = null; },
    ...['t', 'x', 'y', 'vx', 'vy'].flatMap((key) => [NaN, Infinity, '1', undefined].map((bad) => (input) => { input.result.trajectory[1][key] = bad; })),
    (input) => { input.result.trajectory[1].phase = 'landing'; },
    (input) => { input.result.trajectory[1].t = 8; },
    (input) => { input.result.trajectory[1].t = 7; },
    (input) => { input.result.trajectory[0].t = -1e308; input.result.trajectory[2].t = 1e308; },
    (input) => { input.result.trajectory = new Array(50_001); },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => adaptPhysicsResult(input), /Invalid .*: /);
  }
});

test('requires finite input geometry, positive speed/mass, nonnegative downforce, and ordered gap bounds', () => {
  const changes = [
    (input) => { input.problemSpec = null; },
    (input) => { input.problemSpec.ramp_curve_m = [{ x: 1, y: 2 }]; },
    (input) => { input.problemSpec.ramp_curve_m = new Array(2); },
    (input) => { input.problemSpec.ramp_curve_m = new Array(50_001); },
    (input) => { input.problemSpec.ramp_curve_m[0].x = Infinity; },
    (input) => { input.problemSpec.ramp_curve_m[0].y = '0'; },
    (input) => { input.problemSpec.entry_speed_ms = 0; },
    (input) => { input.problemSpec.car_mass_kg = -1; },
    (input) => { input.problemSpec.downforce_capability_n = -1; },
    (input) => { input.problemSpec.ground_profile = null; },
    (input) => { input.problemSpec.ground_profile.type = 'unknown'; },
    (input) => { delete input.problemSpec.ground_profile.landing_level_m; },
    (input) => { input.problemSpec.ground_profile.gap_start_x_m = NaN; },
    (input) => { delete input.problemSpec.ground_profile.gap_end_x_m; },
    (input) => { input.problemSpec.ground_profile.gap_end_x_m = 14; },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => adaptPhysicsResult(input), /Invalid physics result/);
  }
  const input = fixture();
  input.problemSpec.downforce_capability_n = 0;
  assert.equal(adaptPhysicsResult(input).problemSpec.downforce_capability_n, 0);
});

test('validates metrics and execution without coercing nonfinite values', () => {
  const changes = [
    (input) => { input.result.metrics = null; },
    (input) => { input.result.metrics.outcome = 'error'; },
    (input) => { input.result.metrics.traction_ok = 'true'; },
    ...['max_required_downforce_n', 'launch_angle_deg', 'launch_speed_ms', 'hang_time_s', 'max_height_m', 'landing_x_m', 'margin_m'].map((key) => (input) => { input.result.metrics[key] = Infinity; }),
    (input) => { input.result.execution = null; },
    (input) => { input.result.execution.duration_ms = NaN; },
    (input) => { input.result.execution.duration_ms = -1; },
    (input) => { input.result.execution.sandbox_id = 123; },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => adaptPhysicsResult(input), /Invalid physics result/);
  }
});

test('deep-copies supplied spec, metrics, and execution and never mutates input on success or failure', () => {
  const input = fixture();
  input.result.metrics.details = { point: [1, 2] };
  input.result.execution.details = { runner: ['local'] };
  const original = structuredClone(input);
  const adapted = adaptPhysicsResult(input);
  assert.deepEqual(input, original);
  assert.deepEqual(adapted.metrics, input.result.metrics);
  assert.deepEqual(adapted.execution, input.result.execution);
  adapted.problemSpec.ramp_curve_m[0].x = 999;
  adapted.problemSpec.ground_profile.landing_level_m = 999;
  adapted.metrics.details.point[0] = 999;
  adapted.execution.details.runner[0] = 'changed';
  adapted.trajectory.samples[0].position[0] = 999;
  assert.deepEqual(input, original);

  input.result.trajectory[2].t = 8;
  const invalidOriginal = structuredClone(input);
  assert.throws(() => adaptPhysicsResult(input), /strictly increasing/);
  assert.deepEqual(input, invalidOriginal);
});
