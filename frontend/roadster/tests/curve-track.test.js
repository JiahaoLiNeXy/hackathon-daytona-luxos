import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import { createCurveTrack, validateRampCurve } from '../src/curve-track.js';

const curve = () => [{ x: 11, y: -3 }, { x: 14, y: -1 }, { x: 14, y: 6 }, { x: 10, y: 12 }];
const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);

function dispose(group) {
  const materials = new Set();
  group.traverse((object) => {
    if (object.isMesh) { object.geometry.dispose(); materials.add(object.material); }
  });
  for (const material of materials) material.dispose();
}

test('the solid surface keeps every source sample and coordinate origin, without smoothing', () => {
  const input = curve(), group = createCurveTrack(input);
  assert.ok(group instanceof THREE.Group);
  const surface = group.getObjectByName('Ramp_surface');
  const position = surface.geometry.getAttribute('position');
  assert.equal(position.count, input.length * 2);
  input.forEach(({ x, y }, i) => {
    near((position.getX(i * 2) + position.getX(i * 2 + 1)) / 2, x);
    near((position.getY(i * 2) + position.getY(i * 2 + 1)) / 2, y);
    near(position.getZ(i * 2), -2.8);
    near(position.getZ(i * 2 + 1), 2.8);
  });
  assert.equal(surface.geometry.index.count, (input.length - 1) * 6);
  assert.deepEqual(group.position.toArray(), [0, 0, 0]);
  assert.equal(group.userData.units, 'm');
  assert.equal(group.userData.width, 5.6);
  assert.equal(group.userData.thickness, 0.28);
  assert.equal(group.userData.height, 15);
  assert.equal(group.userData.span, 4);
  dispose(group);
});

test('height and sampling changes rebuild actual geometry from the new curve', () => {
  const first = createCurveTrack([{ x: -6, y: 0 }, { x: 0, y: 7 }, { x: -5.5, y: 23 }]);
  const second = createCurveTrack([{ x: -6, y: 0 }, { x: -2, y: 3 }, { x: 0, y: 14 }, { x: -5.5, y: 46 }]);
  const positions = (group) => group.getObjectByName('Ramp_surface').geometry.getAttribute('position');
  assert.equal(positions(first).count, 6);
  assert.equal(positions(second).count, 8);
  assert.equal(positions(first).getY(4), 23);
  assert.equal(positions(second).getY(6), 46);
  assert.equal(first.userData.height, 23);
  assert.equal(second.userData.height, 46);
  assert.notDeepEqual(first.getObjectByName('Ramp_truss_support').position.toArray(), second.getObjectByName('Ramp_truss_support').position.toArray());
  dispose(first); dispose(second);
});

test('retains the reference materials, filled thickness, colored edges, centerline, and steel frame', () => {
  const group = createCurveTrack([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  assert.equal(group.userData.supportStartIndex, 0);
  assert.equal(group.userData.supportStationCount, 2);
  const expected = { Ramp_surface: 0x586066, Ramp_edges: 0xbc5149, Ramp_centerline: 0xeeeae2, Ramp_underside: 0x68717a, Ramp_sides: 0x68717a };
  for (const [name, color] of Object.entries(expected)) {
    const object = group.getObjectByName(name);
    assert.ok(object.isMesh);
    assert.ok(object.material.isMeshStandardMaterial);
    assert.equal(object.material.color.getHex(), color);
    assert.equal(object.material.wireframe, false);
    assert.equal(object.castShadow, true);
    assert.equal(object.receiveShadow, true);
  }
  const underside = group.getObjectByName('Ramp_underside').geometry.getAttribute('position');
  near(underside.getY(0), -0.28);
  assert.ok(group.getObjectByName('Ramp_sides').geometry.index.count > 0);
  near(group.getObjectByName('Ramp_edges').geometry.getAttribute('position').getY(0), 0.025);
  near(group.getObjectByName('Ramp_centerline').geometry.getAttribute('position').getY(0), 0.023);
  assert.equal(group.getObjectByName('Ramp_truss_diagonal').geometry.type, 'CylinderGeometry');
  assert.equal(group.getObjectByName('Ramp_truss_support').material.metalness, 0.75);
  assert.ok(group.getObjectByName('Ramp_truss_base').isMesh);
  dispose(group);
});

test('both 145-point reference fixtures reserve all 13 frame stations for the rising ramp', async () => {
  for (const name of ['original', 'adjusted']) {
    const fixture = JSON.parse(await readFile(new URL(`../public/examples/physics-ramp-${name}.json`, import.meta.url), 'utf8'));
    const input = fixture.problemSpec.ramp_curve_m;
    assert.equal(input.length, 145);
    const group = createCurveTrack(input);
    assert.equal(group.userData.supportStartIndex, 16);
    assert.equal(group.userData.supportStationCount, 13);
    const start = input[group.userData.supportStartIndex];
    assert.deepEqual(start, { x: -6, y: 0 });
    const truss = group.getObjectByName('Ramp_truss');
    assert.equal(truss.children.filter((object) => object.name === 'Ramp_truss_rib').length, 26);
    group.updateMatrixWorld(true);
    for (const object of truss.children.filter((object) => object.geometry.type === 'CylinderGeometry')) {
      const halfLength = object.geometry.parameters.height / 2;
      const ends = [-halfLength, halfLength].map((y) => new THREE.Vector3(0, y, 0).applyMatrix4(object.matrixWorld));
      // Frame joints may sit just below the deck at the entrance, as they do in
      // track.js, but no member may stretch back along the 19 m flat approach.
      for (const end of ends) assert.ok(end.x >= start.x - 1e-8, `${name}: ${object.name} reaches back to ${end.x}`);
      if (object.name === 'Ramp_truss_support') {
        assert.ok(Math.max(...ends.map(({ y }) => y)) > 0, `${name}: support must rise above ground`);
        near(Math.min(...ends.map(({ y }) => y)), 0);
      }
    }
    dispose(group);
  }
});

test('normal offsets remain finite on vertical segments, x reversals, cusps, and closed loops', () => {
  const cases = [
    [{ x: 3, y: 0 }, { x: 3, y: 10 }, { x: 3, y: 20 }],
    curve(),
    [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }],
    [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 0 }],
  ];
  for (const input of cases) {
    const group = createCurveTrack(input);
    group.updateMatrixWorld(true);
    group.traverse((object) => {
      assert.ok(object.matrixWorld.elements.every(Number.isFinite), object.name);
      if (object.isMesh) {
        for (const attribute of Object.values(object.geometry.attributes)) {
          assert.ok(attribute.array.every(Number.isFinite), object.name);
        }
      }
    });
    dispose(group);
  }
  const vertical = createCurveTrack(cases[0]);
  near(vertical.getObjectByName('Ramp_underside').geometry.getAttribute('position').getX(0), 3.28);
  dispose(vertical);
});

test('never mutates source data and stores an independent original-curve copy', () => {
  const input = curve();
  const original = structuredClone(input);
  input.forEach(Object.freeze); Object.freeze(input);
  const validated = validateRampCurve(input);
  const group = createCurveTrack(input, Object.freeze({ width: 7, thickness: 0.4 }));
  assert.deepEqual(input, original);
  assert.deepEqual(group.userData.rampCurve, original);
  assert.notEqual(group.userData.rampCurve, input);
  assert.notEqual(group.userData.rampCurve[0], input[0]);
  validated[0].x = -99;
  group.userData.rampCurve[0].x = -100;
  assert.equal(input[0].x, 11);
  assert.equal(group.userData.width, 7);
  near(group.getObjectByName('Ramp_surface').geometry.getAttribute('position').getZ(0), -3.5);
  dispose(group);
});

test('rejects malformed, nonfinite, duplicate, and rendering-degenerate input without requiring monotonic x', () => {
  for (const input of [
    null, {}, [], [{ x: 0, y: 0 }], new Array(2),
    [{ x: 0, y: 0 }, null], [{ x: 0, y: 0 }, [1, 2]],
    [{ x: 0, y: 0 }, { x: '1', y: 2 }],
    [{ x: 0, y: 0 }, { x: Infinity, y: 2 }],
    [{ x: 0, y: 0 }, { x: 2, y: NaN }],
    [{ x: 2, y: 2 }, { x: 2, y: 2 }],
    [{ x: 1e20, y: 2 }, { x: 1e20 + 1e6, y: 2 }],
    [{ x: 0, y: 0 }, { x: 1e300, y: 2 }],
    new Array(50_001),
  ]) assert.throws(() => validateRampCurve(input), /Invalid ramp curve/);
  assert.deepEqual(validateRampCurve(curve()), curve());
  for (const options of [null, [], { width: 0 }, { width: Infinity }, { thickness: -1 }, { thickness: '1' }, { thickness: 1e-300 }]) {
    assert.throws(() => createCurveTrack(curve(), options), /Invalid ramp curve/);
  }
});

test('accepts 50000 samples while keeping the steel structure bounded', () => {
  const input = Array.from({ length: 50_000 }, (_, i) => ({ x: i / 1000, y: Math.sin(i / 10_000) * 10 }));
  const group = createCurveTrack(input);
  const position = group.getObjectByName('Ramp_surface').geometry.getAttribute('position');
  assert.equal(position.count, 100_000);
  near(position.getX(99_998), input.at(-1).x);
  near(position.getY(99_998), input.at(-1).y);
  assert.equal(group.getObjectByName('Ramp_surface').geometry.index.array.constructor, Uint32Array);
  assert.equal(group.userData.supportStationCount, 13);
  assert.ok(group.getObjectByName('Ramp_truss').children.length < 120);
  dispose(group);
});
