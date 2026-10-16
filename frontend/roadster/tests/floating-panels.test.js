import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainPosition } from '../src/floating-panels.js';

const panel = { width: 320, height: 240 };
const desk = { width: 1200, height: 800 };

test('a panel inside the desk keeps its exact position', () => {
  assert.deepEqual(constrainPosition({ x: 150.5, y: 80.25 }, panel, desk), { x: 150.5, y: 80.25 });
});

test('normal panels clamp to all four 12 px margins', () => {
  assert.deepEqual(constrainPosition({ x: -100, y: -100 }, panel, desk), { x: 12, y: 12 });
  assert.deepEqual(constrainPosition({ x: 5000, y: 5000 }, panel, desk), { x: 868, y: 548 });
});

test('a panel exactly fitting the available area has a single valid origin', () => {
  assert.deepEqual(constrainPosition({ x: 80, y: -30 }, { width: 1176, height: 776 }, desk), { x: 12, y: 12 });
});

test('an oversized module remains draggable with its title origin on screen', () => {
  const large = { width: 900, height: 720 }, smallDesk = { width: 390, height: 600 };
  assert.deepEqual(constrainPosition({ x: -300, y: -400 }, large, smallDesk), { x: 12, y: 12 });
  assert.deepEqual(constrainPosition({ x: 200, y: 200 }, large, smallDesk), { x: 200, y: 200 });
  assert.deepEqual(constrainPosition({ x: 2000, y: 2000 }, large, smallDesk), { x: 282, y: 544 });
});

test('width and height constraints are independent', () => {
  assert.deepEqual(constrainPosition({ x: 1000, y: 1000 }, { width: 900, height: 200 }, { width: 390, height: 600 }), { x: 282, y: 388 });
});

test('an unusually small desk keeps the title at the visible origin', () => {
  assert.deepEqual(constrainPosition({ x: -100, y: 100 }, panel, { width: 50, height: 30 }), { x: 0, y: 0 });
});

test('a bottom dock inset reserves usable space for the full panel', () => {
  assert.deepEqual(constrainPosition({ x: 12, y: 557 }, { width: 320, height: 275 }, { width: 390, height: 844 }, {
    bottomInset: 84,
  }), { x: 12, y: 473 });
  assert.deepEqual(constrainPosition({ x: 12, y: 50 }, panel, { width: 390, height: 60 }, {
    bottomInset: 84,
  }), { x: 12, y: 0 });
});

test('zero-sized hidden desk produces finite coordinates', () => {
  assert.deepEqual(constrainPosition({ x: 100, y: 100 }, panel, { width: 0, height: 0 }), { x: 0, y: 0 });
});

test('measured handle height, reachable width, and margin are configurable', () => {
  assert.deepEqual(constrainPosition({ x: 1000, y: 1000 }, panel, { width: 250, height: 200 }, {
    margin: 8, minimumVisibleWidth: 120, handleHeight: 56,
  }), { x: 122, y: 136 });
});

test('non-finite input cannot write invalid CSS coordinates', () => {
  assert.deepEqual(constrainPosition({ x: NaN, y: Infinity }, panel, desk), { x: 12, y: 12 });
  assert.deepEqual(constrainPosition({ x: 1, y: 1 }, panel, { width: NaN, height: -5 }), { x: 0, y: 0 });
});

test('the helper does not mutate its position or size inputs', () => {
  const position = Object.freeze({ x: -100, y: 5000 });
  constrainPosition(position, Object.freeze({ ...panel }), Object.freeze({ ...desk }));
  assert.deepEqual(position, { x: -100, y: 5000 });
});
