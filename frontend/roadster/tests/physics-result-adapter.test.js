import test from 'node:test';
import assert from 'node:assert/strict';
import { physicsResultToTrajectory } from '../examples/connect-roadster.js';

const result = () => ({
  status: 'ok',
  trajectory: [
    { t: 5, x: -2, y: 7, vx: 3, vy: 4, phase: 'ramp' },
    { t: 6, x: 2, y: 9, vx: 3, vy: 4, phase: 'flight' },
  ],
});

test('PhysicsResult adapter preserves XY/time without inventing alignment or attitude', () => {
  const input = result();
  const before = structuredClone(input);
  const output = physicsResultToTrajectory(input);
  assert.deepEqual(output.samples, [
    { t: 5, position: [-2, 7, 0] }, { t: 6, position: [2, 9, 0] },
  ]);
  assert.equal(output.units, 'm');
  assert.equal(output.upAxis, 'Y');
  assert.equal(output.version, 1);
  assert.deepEqual(input, before);
  assert.equal(output.samples[0].quaternion, undefined);
});

test('PhysicsResult adapter rejects backend errors and insufficient data', () => {
  assert.throws(() => physicsResultToTrajectory({ status: 'error', error: { message: 'solver failed' } }), /solver failed/);
  for (const input of [null, {}, { status: 'ok', trajectory: [] }, { status: 'ok', trajectory: [result().trajectory[0]] }]) {
    assert.throws(() => physicsResultToTrajectory(input));
  }
});

test('PhysicsResult adapter requires finite numeric coordinates and strictly increasing time', () => {
  for (const patch of [{ t: 5 }, { t: 4 }, { t: Infinity }, { x: NaN }, { y: '9' }]) {
    const input = result();
    Object.assign(input.trajectory[1], patch);
    assert.throws(() => physicsResultToTrajectory(input), /finite t\/x\/y and strictly increasing time/);
  }
});
