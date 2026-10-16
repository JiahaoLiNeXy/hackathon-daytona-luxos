import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { normalizeTrajectory, parseTrajectory, sampleTrajectory } from '../src/trajectory.js';

const point = (t, position, quaternion = [0, 0, 0, 1]) => ({ t, position, quaternion });
const valid = () => ({ version: 1, units: 'm', upAxis: 'Y', samples: [point(10, [0, 1, 0]), point(12, [4, 3, 2])] });
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
const nearVector = (actual, expected) => actual.toArray().forEach((value, axis) => near(value, expected[axis]));

test('normalizes nonzero time origin and copies input without moving its spatial origin', () => {
  const input = valid();
  const original = structuredClone(input);
  const trajectory = normalizeTrajectory(input);
  assert.deepEqual(input, original);
  assert.deepEqual(trajectory.samples.map(({ t }) => t), [0, 2]);
  assert.deepEqual(trajectory.samples[0].position, [0, 1, 0]);
  assert.equal(trajectory.duration, 2);
  assert.equal(trajectory.timeOffset, 10);
  assert.equal(trajectory.source, 'imported');
  assert.deepEqual(trajectory.warnings, []);
  trajectory.samples[0].position[0] = 99;
  assert.equal(input.samples[0].position[0], 0);
});

test('interpolates position and shortest-arc orientation with real Three.js types', () => {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).toArray();
  const trajectory = normalizeTrajectory({ samples: [point(0, [0, 0, 0]), point(2, [4, 2, -6], rotation)] });
  const result = sampleTrajectory(trajectory, 1);
  assert.ok(result.position instanceof Vector3);
  assert.ok(result.quaternion instanceof Quaternion);
  nearVector(result.position, [2, 1, -3]);
  nearVector(new Vector3(1, 0, 0).applyQuaternion(result.quaternion), [Math.SQRT1_2, 0, -Math.SQRT1_2]);
  near(result.quaternion.length(), 1);
});

test('clamps both ends and chooses the correct nonuniform time interval', () => {
  const trajectory = normalizeTrajectory({ samples: [point(0, [0, 0, 0]), point(1, [10, 0, 0]), point(5, [30, 0, 0])] });
  nearVector(sampleTrajectory(trajectory, -9).position, [0, 0, 0]);
  nearVector(sampleTrajectory(trajectory, 99).position, [30, 0, 0]);
  nearVector(sampleTrajectory(trajectory, 1).position, [10, 0, 0]);
  nearVector(sampleTrajectory(trajectory, 3).position, [20, 0, 0]);
  assert.throws(() => sampleTrajectory(trajectory, NaN), /finite number/);
});

test('normalizes quaternions, handles equivalent opposite signs, and preserves inversion', () => {
  const trajectory = normalizeTrajectory({ samples: [point(0, [0, 0, 0], [1e300, 0, 0, 0]), point(1, [1, 0, 0], [-1e300, 0, 0, 0])] });
  nearVector(new Vector3(0, 1, 0).applyQuaternion(sampleTrajectory(trajectory, 0.5).quaternion), [0, -1, 0]);
  near(sampleTrajectory(trajectory, 0.5).quaternion.length(), 1);
});

test('derives heading/pitch from the declared +X forward / +Y up / +Z right axes', () => {
  const trajectory = normalizeTrajectory({ samples: [{ t: 0, x: 0, y: 0, z: 0 }, { t: 1, x: 2, y: 2, z: 2 }] });
  const direction = new Vector3(1, 0, 0).applyQuaternion(sampleTrajectory(trajectory, 0).quaternion);
  nearVector(direction, [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
  assert.equal(trajectory.warnings.length, 1);
  assert.match(trajectory.warnings[0], /Roll is not included/);
});

test('inferred headings remain finite through pauses, vertical motion, and exact reversals', () => {
  const cases = [
    [[0, 0, 0], [0, 0, 0], [0, 0, 2], [0, 0, 2]],
    [[0, 0, 0], [0, 2, 0], [0, 4, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 0]],
    [[1, 2, 3], [1, 2, 3], [1, 2, 3]],
  ];
  for (const positions of cases) {
    const trajectory = normalizeTrajectory({ samples: positions.map((position, t) => ({ t, position })) });
    for (let t = 0; t <= trajectory.duration; t += 0.25) {
      const quaternion = sampleTrajectory(trajectory, t).quaternion;
      assert.ok(quaternion.toArray().every(Number.isFinite));
      near(quaternion.length(), 1);
    }
  }
  const vertical = normalizeTrajectory({ samples: [{ t: 0, position: [0, 0, 0] }, { t: 1, position: [0, 1, 0] }] });
  nearVector(new Vector3(1, 0, 0).applyQuaternion(sampleTrajectory(vertical, 0).quaternion), [0, 1, 0]);
});

test('rejects missing, nonfinite, nonnumeric, unordered, mixed, and malformed samples', () => {
  for (const samples of [
    [], [point(0, [0, 0, 0])],
    [point(0, [0, 0, 0]), point(0, [1, 0, 0])],
    [point(1, [0, 0, 0]), point(0, [1, 0, 0])],
    [point(0, [0, 0, 0]), point(Infinity, [1, 0, 0])],
    [point(0, [0, 0, 0]), point(1, ['1', 0, 0])],
    [point(0, [0, 0, 0]), point(1, [NaN, 0, 0])],
    [point(0, [0, 0, 0]), point(1, [0, 0])],
    [point(0, [0, 0, 0]), point(1, new Array(3))],
    [point(0, [0, 0, 0]), point(1, [0, 0, 0], [0, 0, 0, 0])],
    [point(0, [0, 0, 0]), point(1, [0, 0, 0], [0, 1, 0])],
    [point(0, [0, 0, 0]), point(1, [0, 0, 0], new Array(4))],
    [point(0, [0, 0, 0]), { t: 1, position: [1, 0, 0] }],
    [point(0, [0, 0, 0]), { t: 1, x: 1, y: 0, z: 0, qx: 1 }],
  ]) assert.throws(() => normalizeTrajectory({ samples }), /Invalid trajectory/);
  assert.throws(() => normalizeTrajectory({ ...valid(), units: 'mm' }), /units/);
  assert.throws(() => normalizeTrajectory({ ...valid(), upAxis: 'Z' }), /upAxis/);
  assert.throws(() => normalizeTrajectory({ ...valid(), version: 2 }), /version/);
  assert.throws(() => normalizeTrajectory({ ...valid(), label: 12 }), /label/);
  assert.throws(() => normalizeTrajectory(null), /top-level/);
  assert.throws(() => normalizeTrajectory({ samples: new Array(2) }), /must be an object/);
  assert.throws(() => normalizeTrajectory({ samples: [point(-1e308, [0, 0, 0]), point(1e308, [0, 0, 0])] }), /Time span/);
});

test('enforces file and sample limits before accepting imported data', () => {
  assert.throws(() => parseTrajectory(' '.repeat(10 * 1024 * 1024)), /10 MiB/);
  assert.throws(() => parseTrajectory('字'.repeat(3_500_000)), /10 MiB/);
  assert.throws(() => normalizeTrajectory({ samples: Array.from({ length: 50_001 }, (_, t) => point(t, [0, 0, 0])) }), /50000/);
});

test('reads flat JSON, array JSON, BOM, labels, and explicit CSV attitude', () => {
  const flat = { samples: [{ t: 0, x: 0, y: 1, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, { t: 1, x: 2, y: 1, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }] };
  const parsed = parseTrajectory(`\uFEFF${JSON.stringify(flat)}`, 'capture.json');
  assert.equal(parsed.label, 'capture.json');
  assert.equal(parseTrajectory(JSON.stringify({ ...valid(), label: '  Capture A  ' })).label, 'Capture A');
  const csv = '\uFEFF"t",x,y,z,qx,qy,qz,qw\r\n10,0,1,0,0,0,0,1\r\n12,2e0,1,0,0,0,0,2\r\n';
  const imported = parseTrajectory(csv, 'capture.CSV');
  assert.equal(imported.duration, 2);
  assert.deepEqual(imported.samples[1].quaternion, [0, 0, 0, 1]);
  assert.deepEqual(imported.warnings, []);
  const inferred = parseTrajectory('t,x,y,z\n0,0,1,0\n1,1,1,0', 'inferred.csv');
  assert.equal(inferred.warnings.length, 1);
});

test('rejects malformed JSON/CSV and incomplete CSV orientation rather than silently coercing', () => {
  assert.throws(() => parseTrajectory('{broken'), /JSON syntax/);
  assert.throws(() => parseTrajectory('{}', 'file.txt'), /Only/);
  for (const csv of [
    't,x,y,z\n0,0,0,0\n1,,0,0',
    't,x,y,z\n0,0,0,0\n1,Infinity,0,0',
    't,x,y,z\n0,0,0,0\n1,0xff,0,0',
    't,x,y,z\n0,0,0,0\n1,1,0',
    't,x,y,z,qx\n0,0,0,0,0\n1,1,0,0,0',
    't,x,y,z,qx,qy,qz,qw\n0,0,0,0,0,0,0,1\n1,1,0,0,,,,',
    't,x,x,z\n0,0,0,0\n1,1,0,0',
    't,x,y,z,heading\n0,0,0,0,0\n1,1,0,0,0',
  ]) assert.throws(() => parseTrajectory(csv, 'invalid.csv'), /Invalid trajectory/);
});

test('bundled examples import and describe the same synthetic motion', async () => {
  const [json, csv] = await Promise.all(['json', 'csv'].map(async (extension) => parseTrajectory(
    await readFile(new URL(`../public/examples/engineer-trajectory.${extension}`, import.meta.url), 'utf8'),
    `engineer-trajectory.${extension}`,
  )));
  assert.deepEqual(json.samples, csv.samples);
  assert.equal(json.duration, 6);
  assert.match(json.label, /合成/);
});
