import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { assessWall } from '../src/wall-clearance.js';
import { adaptPhysicsResult } from '../src/physics-adapter.js';
import { sampleTrajectory } from '../src/trajectory.js';

const sample = (t, x, y, vx = 1, vy = 0, phase = 'flight') => ({ t, x, y, vx, vy, phase });
const wall = (patch = {}) => ({ enabled: true, x: 0, height: 3, width: 8, thickness: 0.35, ...patch });
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);

function envelope(trajectory) {
  return {
    problemSpec: {
      ramp_curve_m: [{ x: -10, y: 0 }, { x: -9, y: 1 }], entry_speed_ms: 22.2,
      car_mass_kg: 1300, downforce_capability_n: 150000, ground_profile: { type: 'flat', landing_level_m: 0 },
    },
    result: {
      status: 'ok', trajectory,
      metrics: { traction_ok: true, max_required_downforce_n: 0, launch_angle_deg: 0, launch_speed_ms: 22.2, hang_time_s: 1, max_height_m: 10, landing_x_m: 20, outcome: 'landed_normal', margin_m: null },
      execution: { duration_ms: 1, sandbox_id: 'synthetic-unit-test' }, error: null,
    },
  };
}

test('continuous detection catches a fast pass through a thin wall between two clear samples', () => {
  const obstacle = wall({ thickness: 0.001 });
  for (const x of [-20, 20]) {
    assert.equal(assessWall(envelope([sample(0, x, 0), sample(1, x, 0)]), obstacle, { clearance: 0 }).status, 'clear');
  }
  const result = assessWall(envelope([sample(8, -20, 0), sample(9, 20, 0)]), obstacle, { clearance: 0 });
  assert.equal(result.status, 'collision');
  assert.ok(result.firstHit.t > 0.43 && result.firstHit.t < 0.45);
  assert.equal(result.timeOffset, 8);
  assert.ok(result.firstHit.envelopeErrorM <= 0.03);
  assert.ok(result.firstHit.interval[0] <= result.firstHit.t && result.firstHit.interval[1] >= result.firstHit.t);
  assert.equal(result.firstHit.conservative, true);
  assert.equal(result.clearanceM, null);
});

test('checks the car nose and the ramp phase rather than only raw-point flight crossings', () => {
  const result = assessWall(envelope([sample(0, -2.1, 0, 1, 0, 'ramp'), sample(1, -2, 0, 1, 0, 'ramp')]), wall(), { clearance: 0 });
  assert.equal(result.status, 'collision');
  assert.equal(result.firstHit.t, 0);
  assert.equal(result.firstHit.phase, 'ramp');
  assert.deepEqual(result.firstHit.position, [-2.1, 0, 0]);
  near(result.firstHit.displayPosition[1], 0.63);
});

test('encloses rotation between clear endpoint boxes, including the rotating display-center offset', () => {
  const a = sample(0, 2.6, 1.5, 1, 0), b = sample(1, 2.6, 1.5, 0, 1);
  for (const point of [a, b]) {
    assert.equal(assessWall(envelope([{ ...point, t: 0 }, { ...point, t: 1 }]), wall(), { clearance: 0 }).status, 'clear');
  }
  const input = envelope([a, b]);
  const result = assessWall(input, wall(), { clearance: 0 });
  assert.equal(result.status, 'collision');
  assert.ok(result.firstHit.t > 0 && result.firstHit.t < 1);
  const pose = sampleTrajectory(adaptPhysicsResult(input).trajectory, result.firstHit.t);
  const expected = pose.position.clone().add(new Vector3(0, 0.63, 0).applyQuaternion(pose.quaternion));
  expected.toArray().forEach((value, i) => near(result.firstHit.displayPosition[i], value));
});

test('uses the displayed height offset, scaled car dimensions, and rotated local +Y', () => {
  const flat = envelope([sample(0, 0, 0), sample(1, 0, 0)]);
  for (const scale of [1, 2]) {
    assert.equal(assessWall(flat, wall({ height: 0.02 }), { scale, clearance: 0 }).status, 'clear');
    assert.equal(assessWall(flat, wall({ height: 0.06 }), { scale, clearance: 0 }).status, 'collision');
  }
  const vertical = assessWall(envelope([sample(0, 0, 4, 0, 1), sample(1, 0, 4, 0, 1)]), wall({ x: -0.63, height: 2 }), { clearance: 0 });
  assert.equal(vertical.status, 'collision');
  assert.deepEqual(vertical.firstHit.position, [0, 4, 0]);
  vertical.firstHit.displayPosition.forEach((value, i) => near(value, [-0.63, 4, 0][i]));
});

test('holds zero-speed heading just like the physics adapter', () => {
  const input = envelope([sample(0, 10, 4, 0, 1), sample(1, 0, 4, 0, 0), sample(2, 0, 4, 0, 0)]);
  const result = assessWall(input, wall({ x: -0.63, height: 2 }), { clearance: 0 });
  assert.equal(result.status, 'collision');
  const pose = sampleTrajectory(adaptPhysicsResult(input).trajectory, result.firstHit.t);
  const expected = pose.position.clone().add(new Vector3(0, 0.63, 0).applyQuaternion(pose.quaternion)).toArray();
  result.firstHit.displayPosition.forEach((value, i) => near(value, expected[i]));
  near(result.firstHit.displayPosition[0] - result.firstHit.position[0], -0.63);
});

test('checks a later reverse crossing after the first wall crossing safely passes above it', () => {
  const input = envelope([
    sample(0, -10, 8), sample(1, 10, 8),
    sample(2, 10, 1.5, -1, 0), sample(3, -10, 1.5, -1, 0),
  ]);
  const result = assessWall(input, wall({ height: 2 }), { clearance: 0 });
  assert.equal(result.status, 'collision');
  assert.ok(result.firstHit.t > 2 && result.firstHit.t < 3);
  assert.equal(assessWall(envelope(input.result.trajectory.slice(0, 2)), wall({ height: 2 }), { clearance: 0 }).status, 'clear');
});

test('distinguishes safe passage from the requested conservative clearance margin without inventing a minimum', () => {
  const input = envelope([sample(0, 0, 1.1), sample(1, 0, 1.1)]);
  const clear = assessWall(input, wall({ height: 1 }), { clearance: 0 });
  assert.equal(clear.status, 'clear');
  assert.equal(clear.firstHit, null);
  assert.equal(clear.clearanceM, null);
  assert.match(clear.method, /Conservative continuous.*0.03 m/);
  assert.equal(assessWall(input, wall({ height: 1 })).status, 'collision');
  const disabled = assessWall(input, wall({ enabled: false }));
  assert.equal(disabled.status, 'clear');
  assert.equal(disabled.checkedSegments, 0);
  assert.match(disabled.method, /Wall disabled/);
});

test('does not mutate the envelope, wall, or options', () => {
  const input = envelope([sample(0, -10, 0), sample(1, 10, 0)]), obstacle = wall(), options = { scale: 1, clearance: 0.2 };
  const originals = structuredClone([input, obstacle, options]);
  assessWall(input, obstacle, options);
  assert.deepEqual([input, obstacle, options], originals);
});

test('invalid input, backend failures, and numeric limits never turn into clear or throw', () => {
  const valid = () => envelope([sample(0, -10, 0), sample(1, 10, 0)]);
  for (const args of [
    [null, wall()], [{ result: { status: 'error', error: { code: 'failed', message: 'backend failed' } } }, wall()],
    [valid(), null], [valid(), wall({ enabled: 1 })], [valid(), wall({ x: NaN })],
    [valid(), wall({ height: 0 })], [valid(), wall({ thickness: 0 })], [valid(), wall({ width: -1 })],
    [valid(), wall(), null], [valid(), wall(), { scale: 0 }], [valid(), wall(), { scale: 101 }],
    [valid(), wall(), { clearance: -0.1 }], [valid(), wall(), { clearance: Infinity }],
    [envelope([sample(0, 1e8, 0), sample(1, 1e8 + 1, 0)]), wall()],
    [envelope([sample(0, 0, 0), sample(0, 1, 0)]), wall()],
    [envelope(new Array(50_001)), wall()],
  ]) {
    const result = assessWall(...args);
    assert.equal(result.status, 'invalid');
    assert.equal(result.firstHit, null);
    assert.equal(result.clearanceM, null);
    assert.ok(result.reason.length > 0);
  }
});

test('an exhausted continuous-check budget returns invalid rather than an unverified pass', () => {
  const input = envelope(Array.from({ length: 8_000 }, (_, i) => sample(i, i % 2 ? 1_000 : -1_000, 100)));
  const result = assessWall(input, wall({ height: 1 }), { clearance: 0 });
  assert.equal(result.status, 'invalid');
  assert.match(result.reason, /exceeded 100000 interval checks/);
  assert.equal(result.firstHit, null);
});
