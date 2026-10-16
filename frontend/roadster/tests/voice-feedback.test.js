import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceFeedback} from '../src/voice-feedback.js';

function fixture(execute = async () => undefined) {
  const frames = [];
  const voice = createVoiceFeedback({execute, render: state => frames.push(state)});
  return {voice, frames};
}
const attempt = (status, traction = true) => ({assessment: {status}, result: {metrics: {traction_ok: traction}}});

test('idle is hidden until real host speech updates arrive; input text is bounded', () => {
  const {voice, frames} = fixture();
  assert.equal(voice.getState().phase, 'idle');
  assert.equal(frames.length, 0);
  voice.setVoiceState({phase: 'listening'});
  voice.setVoiceState({phase: 'thinking', transcript: 'Move the wall'});
  assert.equal(frames.at(-1).transcript, 'Move the wall');
  assert.throws(() => voice.setVoiceState({phase: 'done'}), /phase/);
  assert.throws(() => voice.setVoiceState({phase: 'thinking', transcript: 'x'.repeat(501)}), /500/);
  voice.setVoiceState({phase: 'idle'});
  assert.deepEqual(voice.getState(), {phase: 'idle', transcript: '', action: '', detail: ''});
});

test('recognized instruction executes the real action once and waits for its result', async () => {
  let finish;
  const calls = [];
  const {voice} = fixture((...args) => { calls.push(args); return new Promise(resolve => {finish = resolve;}); });
  const payload = {enabled: true, x: -18};
  const pending = voice.runVoiceCommand({transcript: 'Add a wall', command: 'setWall', payload});
  assert.equal(voice.getState().phase, 'executing');
  assert.equal(voice.getState().action, 'Updating wall');
  assert.deepEqual(calls, [['setWall', payload]]);
  const result = {applied: true};
  finish(result);
  assert.equal(await pending, result);
  assert.equal(voice.getState().detail, 'Wall updated.');
});

test('collision, no solution, lost traction and clear results have distinct honest feedback', async () => {
  const cases = [
    ['runTrial', {before: attempt('collision')}, 'attention', /Wall hit/],
    ['adjustRamp', {before: attempt('collision'), after: null}, 'attention', /No clear ramp/],
    ['runTrial', {before: attempt('clear', false)}, 'attention', /Lost traction/],
    ['adjustRamp', {before: attempt('collision'), after: attempt('clear')}, 'done', /Ramp adjusted. Wall cleared/],
  ];
  for (const [command, result, phase, message] of cases) {
    const {voice} = fixture(async () => result);
    assert.equal(await voice.runVoiceCommand({transcript: 'Try the ramp', command}), result);
    assert.equal(voice.getState().phase, phase);
    assert.match(voice.getState().detail, message);
  }
});

test('execution errors and cancelled calculations are not presented as success', async () => {
  const {voice} = fixture(async () => {throw new Error('Service unavailable');});
  await assert.rejects(voice.runVoiceCommand({transcript: 'Run', command: 'runTrial'}), /Service unavailable/);
  assert.equal(voice.getState().phase, 'error');
  const cancelled = fixture();
  await assert.rejects(cancelled.voice.runVoiceCommand({transcript: 'Run', command: 'runTrial'}), /cancelled/);
  assert.equal(cancelled.voice.getState().phase, 'error');
});

test('an older completion cannot overwrite newer speech or a hidden caption', async () => {
  let finish;
  const {voice} = fixture(() => new Promise(resolve => {finish = resolve;}));
  const pending = voice.runVoiceCommand({transcript: 'Adjust ramp', command: 'adjustRamp'});
  voice.setVoiceState({phase: 'thinking', transcript: 'Move the wall instead'});
  const result = {before: attempt('collision'), after: attempt('clear')};
  finish(result);
  assert.equal(await pending, result);
  assert.equal(voice.getState().transcript, 'Move the wall instead');
  assert.equal(voice.getState().phase, 'thinking');
  const second = voice.runVoiceCommand({transcript: 'Adjust ramp', command: 'adjustRamp'});
  voice.setVoiceState({phase: 'idle'});
  finish(result);
  await second;
  assert.equal(voice.getState().phase, 'idle');
});

test('voice transport cannot recurse, export files, or execute an arbitrary method', async () => {
  let calls = 0;
  const {voice} = fixture(() => calls++);
  for (const command of ['runVoiceCommand', 'setVoiceState', 'exportGLB', 'getState', 'constructor', 'missing']) {
    await assert.rejects(voice.runVoiceCommand({transcript: 'Test', command}), /disallowed/);
  }
  await assert.rejects(voice.runVoiceCommand({transcript: '', command: 'play'}), /nonempty/);
  assert.equal(calls, 0);
});
