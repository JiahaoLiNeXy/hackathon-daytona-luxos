import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createIntegrationBridge, INTEGRATION_COMMANDS } from '../src/integration-bridge.js';

class DetailEvent extends Event {
  constructor(type, options) { super(type); this.detail = options.detail; }
}
class MockWindow extends EventTarget {
  constructor({ standalone = false } = {}) {
    super();
    this.location = { origin: 'https://sim.example' };
    this.crypto = webcrypto;
    this.CustomEvent = DetailEvent;
    this.messages = [];
    this.parent = standalone ? this : { postMessage: (data, targetOrigin) => this.messages.push({ data, targetOrigin }) };
  }
  receive(data, options = {}) {
    const event = new Event('message');
    Object.assign(event, { data, origin: this.location.origin, source: this.parent }, options);
    this.dispatchEvent(event);
  }
}
function fixture(options) {
  const host = new MockWindow(options);
  const parameters = { vehicleScale: 1, rampHeight: 2, wall: { enabled: false, x: 12, height: 3 } };
  const state = { time: 0, position: [1, 2, 3], nested: { value: 5 } };
  const calls = [];
  const api = {
    play: payload => { calls.push(['play', payload]); return { playing: true }; },
    setVehicleScale: value => { parameters.vehicleScale = value; },
    setRampHeight: value => { parameters.rampHeight = value; },
    setWall: value => Object.assign(parameters.wall, value),
    setPlaybackRate: value => { calls.push(['rate', value]); return value; },
    seek: () => { throw new Error('Time must be finite.'); },
    exportGLB: () => { calls.push(['export']); },
  };
  const bridge = createIntegrationBridge({ host, api, getState: () => state, getParameters: () => parameters });
  const send = (command, extra = {}) => host.receive({ type: 'roadster:command', requestId: 'request-1', protocolVersion: 1, command, ...extra });
  return { host, api, state, parameters, calls, bridge, send };
}
const messagesOf = (host, type) => host.messages.filter(entry => entry.data.type === type).map(entry => entry.data);

test('only same-origin parent commands run; standalone messages are ignored', () => {
  const { host, calls, send } = fixture();
  const command = { type: 'roadster:command', requestId: '1', command: 'play' };
  host.receive(command, { source: {} });
  host.receive(command, { origin: 'https://attacker.example' });
  host.receive({ ...command, type: 'other' });
  assert.equal(calls.length, 0);
  assert.equal(host.messages.length, 0);
  send('play');
  assert.equal(calls.length, 1);
  assert.equal(host.messages[0].targetOrigin, host.location.origin);
  const standalone = fixture({ standalone: true });
  standalone.send('play');
  assert.equal(standalone.calls.length, 0);
});

test('ready announces snapshots locally and to parent; late listeners can query readiness', () => {
  const { host, bridge, send, state } = fixture();
  assert.equal(host.messages.length, 0);
  const events = [];
  host.addEventListener('roadster:ready', event => events.push(event.detail));
  const ready = bridge.announceReady();
  assert.equal(ready.ready, true);
  assert.equal(ready.protocolVersion, 1);
  assert.match(ready.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(ready.commands, INTEGRATION_COMMANDS);
  assert.equal(ready.commands.includes('exportGLB'), false);
  events[0].state.position[0] = -100;
  ready.commands.length = 0;
  assert.equal(state.position[0], 1);
  assert.equal(messagesOf(host, 'roadster:ready')[0].state.position[0], 1);
  send('getReadyState', { requestId: 'late-listener' });
  const response = messagesOf(host, 'roadster:result').at(-1);
  assert.equal(response.requestId, 'late-listener');
  assert.equal(response.instanceId, ready.instanceId);
  assert.equal(response.result.ready, true);
  assert.equal(response.result.commands.includes('setPlaybackRate'), true);
  assert.equal(response.result.state.parameterRevision, 0);
});

test('standalone page receives local ready events without parent messaging', () => {
  const { host, bridge } = fixture({ standalone: true });
  let ready;
  host.addEventListener('roadster:ready', event => { ready = event.detail; });
  bridge.announceReady();
  assert.equal(ready.ready, true);
  assert.equal(host.messages.length, 0);
});

test('legacy requests without a version and the playback-rate command remain supported', () => {
  const { host, send, calls } = fixture();
  send('play', { protocolVersion: undefined });
  send('setPlaybackRate', { payload: 2 });
  assert.deepEqual(calls, [['play', undefined], ['rate', 2]]);
  const responses = messagesOf(host, 'roadster:result');
  assert.equal(responses.length, 2);
  assert.equal(responses[1].result, 2);
  assert.equal(responses[1].protocolVersion, 1);
});

test('invalid request IDs, unsupported versions, forbidden commands, and API failures return clear errors', () => {
  const { host, send, calls } = fixture();
  for (const requestId of [undefined, '', '   ', 12, 'x'.repeat(129)]) send('play', { requestId });
  send('play', { protocolVersion: 2 });
  send('play', { protocolVersion: null });
  send('exportGLB');
  send('__proto__');
  send('reset');
  send('seek');
  const errors = messagesOf(host, 'roadster:error');
  assert.deepEqual(errors.map(error => error.code), [
    ...Array(5).fill('INVALID_REQUEST'), 'UNSUPPORTED_VERSION', 'UNSUPPORTED_VERSION',
    'UNKNOWN_COMMAND', 'UNKNOWN_COMMAND', 'COMMAND_FAILED', 'COMMAND_FAILED',
  ]);
  assert.equal(errors[0].requestId, null);
  assert.equal(errors.at(-1).error, 'Time must be finite.');
  assert.ok(errors.every(error => typeof error.error === 'string' && error.protocolVersion === 1 && error.instanceId));
  assert.equal(calls.length, 0);
  send('play', { requestId: 'x'.repeat(128) });
  assert.equal(messagesOf(host, 'roadster:result').length, 1);
});

test('parameter notifications deduplicate, report root keys, preserve snapshots, and increment revision', () => {
  const { host, parameters, state, bridge, send } = fixture();
  const events = [];
  host.addEventListener('roadster:parameters-changed', event => events.push(event.detail));
  assert.equal(bridge.getRevision(), 0);
  assert.equal(bridge.notifyParametersChanged('ui'), false);
  assert.equal(host.messages.length, 0);
  parameters.wall.enabled = true;
  assert.equal(bridge.notifyParametersChanged('ui'), true);
  assert.deepEqual(events[0].changed, ['wall']);
  assert.equal(events[0].revision, 1);
  assert.equal(events[0].source, 'ui');
  assert.deepEqual(events[0].parameters, parameters);
  events[0].parameters.wall.x = 500;
  events[0].changed.push('vehicleScale');
  assert.equal(parameters.wall.x, 12);
  assert.equal(messagesOf(host, 'roadster:parameters-changed')[0].parameters.wall.x, 12);
  assert.equal(bridge.notifyParametersChanged('api'), false);
  parameters.vehicleScale = 1.5;
  parameters.rampHeight = 4;
  parameters.wall.height = 5;
  assert.equal(bridge.notifyParametersChanged('api'), true);
  assert.deepEqual(events[1].changed, ['vehicleScale', 'rampHeight', 'wall']);
  assert.equal(bridge.getRevision(), 2);
  send('getState');
  const reported = messagesOf(host, 'roadster:result').at(-1).result;
  assert.equal(reported.parameterRevision, 2);
  reported.nested.value = 100;
  assert.equal(state.nested.value, 5);
  assert.throws(() => bridge.notifyParametersChanged('startup'), /source/);
  assert.equal(bridge.getRevision(), 2);
});

test('parameter commands notify with api source and deduplicate explicit setter notifications', () => {
  const { host, send, api, parameters, bridge } = fixture();
  api.setVehicleScale = value => {
    parameters.vehicleScale = value;
    bridge.notifyParametersChanged('api');
  };
  send('setVehicleScale', { payload: 1.25 });
  send('setVehicleScale', { payload: 1.25 });
  send('setWall', { payload: { x: 20, enabled: true } });
  const changes = messagesOf(host, 'roadster:parameters-changed');
  assert.equal(changes.length, 2);
  assert.equal(changes[0].source, 'api');
  assert.equal(changes[1].revision, 2);
  assert.deepEqual(changes[1].changed, ['wall']);
});

test('each bridge has its own identity and returned snapshots cannot change internal state', () => {
  const first = fixture(), second = fixture();
  assert.notEqual(first.bridge.getReadyState().instanceId, second.bridge.getReadyState().instanceId);
  const ready = first.bridge.getReadyState();
  ready.state.parameterRevision = 99;
  ready.state.position[0] = 100;
  assert.equal(first.bridge.getRevision(), 0);
  assert.equal(first.bridge.getReadyState().state.position[0], 1);
});

test('destroy removes message handling and suppresses pending async replies and later notifications', async () => {
  const { host, api, send, bridge, parameters, calls } = fixture();
  let resolve;
  api.play = () => new Promise(done => { resolve = done; });
  send('play');
  bridge.destroy();
  bridge.destroy();
  resolve({ playing: true });
  await new Promise(done => setImmediate(done));
  send('setPlaybackRate', { payload: 2 });
  parameters.vehicleScale = 2;
  assert.equal(bridge.notifyParametersChanged('api'), false);
  assert.equal(bridge.announceReady(), false);
  assert.equal(bridge.getReadyState().ready, false);
  assert.equal(host.messages.length, 0);
  assert.equal(calls.length, 0);
});

test('successful and rejected async API methods produce one correlated response each', async () => {
  const { host, api, send } = fixture();
  api.play = async () => ({ playing: true });
  api.pause = async () => { throw new Error('Pause failed.'); };
  send('play', { requestId: 'async-ok' });
  send('pause', { requestId: 'async-error' });
  await new Promise(done => setImmediate(done));
  assert.equal(messagesOf(host, 'roadster:result')[0].requestId, 'async-ok');
  assert.equal(messagesOf(host, 'roadster:error')[0].requestId, 'async-error');
  assert.equal(messagesOf(host, 'roadster:error')[0].error, 'Pause failed.');
});
