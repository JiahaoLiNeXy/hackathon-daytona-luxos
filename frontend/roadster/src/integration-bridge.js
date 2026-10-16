export const INTEGRATION_PROTOCOL_VERSION = 1;
export const INTEGRATION_COMMANDS = Object.freeze([
  'loadTrajectory', 'run', 'play', 'pause', 'seek', 'setVehicleScale', 'setRampHeight',
  'setWall', 'reset', 'setView', 'getState', 'showModule', 'hideModule',
  'moveModule', 'setPlaybackRate', 'getReadyState',
  'setRampCurve', 'loadPhysicsResult', 'runTrial', 'adjustRamp', 'compare', 'setEntrySpeed',
  'setVoiceState', 'runVoiceCommand',
]);

const parameterCommands = new Set(['setVehicleScale', 'setRampHeight', 'setWall', 'setRampCurve', 'loadPhysicsResult', 'setEntrySpeed']);
const allowedCommands = new Set(INTEGRATION_COMMANDS);
const snapshot = value => globalThis.structuredClone(value);

function makeInstanceId(host) {
  const crypto = host.crypto || globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Versioned direct-window events and same-origin parent message transport.
 * Direct API/UI setters should call notifyParametersChanged('api' | 'ui').
 * Transport parameter commands also notify; snapshot comparison deduplicates.
 */
export function createIntegrationBridge({ host = globalThis.window, api, getState, getParameters }) {
  if (!host?.addEventListener || !host?.dispatchEvent || !host.location?.origin) {
    throw new TypeError('Integration bridge requires a window-like host.');
  }
  if (!api || typeof getState !== 'function' || typeof getParameters !== 'function') {
    throw new TypeError('Integration bridge requires api, getState, and getParameters.');
  }
  const instanceId = makeInstanceId(host);
  const origin = host.location.origin;
  const CustomEventClass = host.CustomEvent || globalThis.CustomEvent;
  let parameterRevision = 0;
  let destroyed = false;

  function readParameters() {
    const value = getParameters();
    if (!value || !value.wall || typeof value.wall.enabled !== 'boolean' ||
        ![value.vehicleScale, value.rampHeight, value.wall.x, value.wall.height].every(Number.isFinite)) {
      throw new TypeError('Parameters require finite vehicleScale, rampHeight, wall.x, wall.height and boolean wall.enabled.');
    }
    const parameters = {
      vehicleScale: value.vehicleScale,
      rampHeight: value.rampHeight,
      wall: { enabled: value.wall.enabled, x: value.wall.x, height: value.wall.height },
    };
    if (value.entrySpeedMs !== undefined) {
      if (!Number.isFinite(value.entrySpeedMs)) throw new TypeError('entrySpeedMs must be finite.');
      parameters.entrySpeedMs = value.entrySpeedMs;
    }
    if (value.rampCurve !== undefined) {
      if (!Array.isArray(value.rampCurve) || value.rampCurve.length < 2 ||
          !value.rampCurve.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
        throw new TypeError('rampCurve requires at least two finite x/y points.');
      }
      parameters.rampCurve = value.rampCurve.map(({ x, y }) => ({ x, y }));
    }
    return parameters;
  }
  let previousParameters = readParameters();

  function readState() {
    return { ...snapshot(getState()), parameterRevision };
  }
  function getReadyState() {
    return {
      ready: !destroyed,
      protocolVersion: INTEGRATION_PROTOCOL_VERSION,
      instanceId,
      state: readState(),
      commands: [...INTEGRATION_COMMANDS],
    };
  }
  function parentAvailable() {
    // An explicit target origin makes cross-origin parents ineligible to receive.
    return host.parent && host.parent !== host && origin !== 'null';
  }
  function envelope(type, fields) {
    return { type, protocolVersion: INTEGRATION_PROTOCOL_VERSION, instanceId, ...fields };
  }
  function publish(type, fields) {
    if (destroyed) return;
    const message = envelope(type, fields);
    if (parentAvailable()) host.parent.postMessage(snapshot(message), origin);
    host.dispatchEvent(new CustomEventClass(type, { detail: snapshot(message) }));
  }
  function announceReady() {
    if (destroyed) return false;
    const ready = getReadyState();
    publish('roadster:ready', ready);
    return ready;
  }
  function notifyParametersChanged(source) {
    if (source !== 'ui' && source !== 'api') throw new TypeError('Parameter change source must be "ui" or "api".');
    if (destroyed) return false;
    const parameters = readParameters();
    const changed = [];
    for (const key of ['vehicleScale', 'rampHeight', 'entrySpeedMs']) {
      if (!Object.is(parameters[key], previousParameters[key])) changed.push(key);
    }
    if (['enabled', 'x', 'height'].some(key => !Object.is(parameters.wall[key], previousParameters.wall[key]))) changed.push('wall');
    if (JSON.stringify(parameters.rampCurve) !== JSON.stringify(previousParameters.rampCurve)) changed.push('rampCurve');
    if (!changed.length) return false;
    previousParameters = snapshot(parameters);
    parameterRevision++;
    publish('roadster:parameters-changed', { revision: parameterRevision, source, parameters, changed });
    return true;
  }
  function reply(type, requestId, fields) {
    if (!destroyed && parentAvailable()) host.parent.postMessage(snapshot(envelope(type, { requestId, ...fields })), origin);
  }
  function error(requestId, code, message) {
    reply('roadster:error', requestId, { code, error: message });
  }
  async function onMessage(event) {
    if (destroyed || !parentAvailable() || event.source !== host.parent || event.origin !== origin || event.data?.type !== 'roadster:command') return;
    const { requestId, protocolVersion, command, payload } = event.data;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
      error(null, 'INVALID_REQUEST', 'requestId must be a nonempty string of at most 128 characters.');
      return;
    }
    if (protocolVersion !== undefined && protocolVersion !== INTEGRATION_PROTOCOL_VERSION) {
      error(requestId, 'UNSUPPORTED_VERSION', `Unsupported protocolVersion. Expected ${INTEGRATION_PROTOCOL_VERSION}.`);
      return;
    }
    if (!allowedCommands.has(command)) {
      error(requestId, 'UNKNOWN_COMMAND', 'Unknown or disallowed command.');
      return;
    }
    try {
      let result;
      if (command === 'getReadyState') result = getReadyState();
      else if (command === 'getState') result = readState();
      else {
        if (typeof api[command] !== 'function') {
          error(requestId, 'COMMAND_FAILED', 'The requested API method is unavailable.');
          return;
        }
        result = api[command](snapshot(payload));
        if (result && typeof result.then === 'function') result = await result;
        if (destroyed) return;
        if (parameterCommands.has(command)) notifyParametersChanged('api');
      }
      reply('roadster:result', requestId, { result });
    } catch (cause) {
      error(requestId, 'COMMAND_FAILED', typeof cause?.message === 'string' ? cause.message : String(cause));
    }
  }
  host.addEventListener('message', onMessage);

  return Object.freeze({
    announceReady,
    notifyParametersChanged,
    getReadyState,
    getRevision: () => parameterRevision,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      host.removeEventListener('message', onMessage);
    },
  });
}
