/** Pure XY adapter. The caller must align solver coordinates with the visual model. */
export function physicsResultToTrajectory(result) {
  if (result?.status !== 'ok') throw new Error(result?.error?.message || 'PhysicsResult status must be "ok".');
  if (!Array.isArray(result.trajectory) || result.trajectory.length < 2) {
    throw new Error('PhysicsResult needs at least two trajectory samples.');
  }
  let previousTime = -Infinity;
  const samples = result.trajectory.map((point) => {
    if (!point || ![point.t, point.x, point.y].every(Number.isFinite) || point.t <= previousTime) {
      throw new Error('PhysicsResult requires finite t/x/y and strictly increasing time.');
    }
    previousTime = point.t;
    return { t: point.t, position: [point.x, point.y, 0] };
  });
  return { version: 1, units: 'm', upAxis: 'Y', label: 'PhysicsResult — XY projection; attitude inferred', samples };
}

/** Direct calling adapter for an engineer's voice/video tool dispatcher. No UI or SDK. */
export function connectRoadster(view, { onReady = () => {}, onParameters = () => {} } = {}) {
  let disconnected = false;
  let readyInstance = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const getReadyState = () => view.roadsterSim?.getReadyState();

  function acceptReady(snapshot) {
    if (disconnected || !snapshot?.ready || snapshot.protocolVersion !== 1) return;
    resolveReady(snapshot);
    if (readyInstance !== snapshot.instanceId) {
      readyInstance = snapshot.instanceId;
      onReady(snapshot);
    }
  }
  function handleReady(event) { acceptReady(event.detail); }
  function handleParameters(event) {
    if (!disconnected) onParameters(structuredClone(event.detail));
  }
  view.addEventListener('roadster:ready', handleReady);
  view.addEventListener('roadster:parameters-changed', handleParameters);
  acceptReady(getReadyState()); // Also works when the ready event was already emitted.

  return {
    ready,
    getReadyState,
    async dispatch(command, payload) {
      if (disconnected) throw new Error('Roadster connection is disconnected.');
      const api = view.roadsterSim;
      const snapshot = api?.getReadyState();
      if (!snapshot?.ready || snapshot.protocolVersion !== 1) throw new Error('Roadster is not ready.');
      if (!snapshot.commands.includes(command)) throw new Error(`Unknown or disallowed Roadster command: ${command}`);
      return api[command](payload); // Existing API validation and errors pass through to the caller.
    },
    disconnect() {
      disconnected = true;
      view.removeEventListener('roadster:ready', handleReady);
      view.removeEventListener('roadster:parameters-changed', handleParameters);
    },
  };
}
