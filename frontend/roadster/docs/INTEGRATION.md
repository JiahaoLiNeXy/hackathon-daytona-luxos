# Video background + existing Roadster overlay

Display the phone's live tabletop video full-screen, with the existing transparent `/?embed=1` Roadster UI over it. Keep the four product modules and their styles. The engineer supplies phone capture and the conversation pipeline; this package supplies the UI commands and feedback, without an additional control page.

## Use this repository's desktop overlay

The repository now includes `overlay/overlay.py`, a transparent pywebview window over FaceTime (or the full screen). Use that existing window for a phone feed displayed on the desktop. From the repository, start the UI server with `cd frontend/roadster && npm ci && npm run dev`. In your existing Python overlay environment, from the repository root:

```sh
python overlay/overlay.py --url 'http://127.0.0.1:4178/?embed=1' --fullscreen --interactive
```

`--interactive` is needed for clicks and dragging. Omit `--fullscreen` to follow the FaceTime window instead. `/?embed=1` removes the reference desk photo and leaves the original UI transparent. The video remains in the underlying phone/FaceTime window. The CLI's existing local-file mode is preserved.

The ZIP also includes `overlay/overlay.py` and the local calculation service. In its extracted root run `npm ci && npm run preview`, then use the same overlay command on port **4178**. Node.js 18+ and Python 3.9+ are required. Static `http.server` can display the model but cannot execute the wall experiment. Reuse the engineer's Python environment with pywebview and the existing macOS overlay dependencies.

The current `capture/listen.py` uses transcription and spoken replies; it does not automatically execute UI commands. In the engineer's Python process that owns the pywebview `window`, route the interpreted operation to the page using [pywebview's evaluate_js API](https://pywebview.flowrl.com/api/#window-evaluate-js):

```python
import json

def roadster_command(window, command, payload=None, *, on_result):
    args = json.dumps([command, payload], allow_nan=False)
    return window.evaluate_js("""(async () => {
      const [command, payload] = """ + args + """;
      const api = window.roadsterSim;
      if (!api?.getReadyState().ready) return {ok:false, error:'UI not ready'};
      if (!api.getReadyState().commands.includes(command)) return {ok:false, error:'Unknown command'};
      try {
        const result = await api[command](payload);
        return {ok:true, result:result ?? null, state:api.getState()};
      } catch (error) { return {ok:false, error:error.message}; }
    })()""", callback=on_result)

# Call after the page is loaded and getReadyState reports ready.
roadster_command(window, 'setWall', {'enabled': True, 'x': -18, 'height': 3},
                 on_result=lambda reply: print(reply['ok']))
# Invoke runTrial after the setter completes; invoke adjustRamp after trial completes.
# Use the callback reply, not evaluate_js's immediate return value, for async results.
```

This is calling code for the process that owns the window, not a new HTTP service. Phone capture, speech intent handling and the existing process-to-process coordination stay with the engineer.

## If the engineer already receives video in a browser

Serve the Roadster build under `/roadster/` on the host's **same origin** and proxy `/api/obstacle` on that origin to the local UI service. The service accepts loopback hosts and same-origin calls; deploy it behind the host's local proxy rather than exposing a public solver. The following belongs in your host application; no product source or CSS change is needed:

```html
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
  #tabletop, #roadster { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  #tabletop { object-fit: cover; }
  #roadster { z-index: 1; background: transparent; mix-blend-mode: screen; }
</style>
<video id="tabletop" autoplay muted playsinline></video>
<iframe id="roadster" title="Roadster overlay"></iframe>
```

Import or copy the optional `examples/connect-roadster.js` into your host code. It has no automatic startup, SDK or UI:

```js
import { connectRoadster } from './examples/connect-roadster.js';
const video = document.getElementById('tabletop');
const frame = document.getElementById('roadster');

// Call this when your phone-stream transport supplies a MediaStream.
function attachPhoneStream(stream) { video.srcObject = stream; return video.play(); }

// Attach to the iframe's loaded document, then wait for the UI itself to be ready.
const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
frame.src = '/roadster/?embed=1';
await loaded;
const ui = connectRoadster(frame.contentWindow, {
  onReady: snapshot => { /* enable your agent's UI tools */ },
  onParameters: change => { /* forward the changed state to your agent */ },
});
await ui.ready;
// ui.disconnect() on unmount; reconnect after iframe navigation.
```

`connectRoadster` uses `window.roadsterSim`, `getReadyState()` and local CustomEvents. It allows only the commands advertised by the integration contract, forwards API errors and returns their real results. Calls before readiness or after disconnection fail explicitly. For a late caller, `ui.getReadyState()` returns `{ ready, protocolVersion: 1, instanceId, state, commands }` without needing another ready event.

## If using ElevenLabs browser client tools

Register a client-side handler that forwards to this dispatcher. The configured tool name and parameter names are case-sensitive and must match the handler registration. Enable **Wait for response** so the conversation receives the actual execution result. [ElevenLabs client tools documentation](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools).

Configure `roadsterCommand` with required string `command` and optional string `payloadJson`. The latter contains JSON: `0.5` for a rate, `"edit-panel"` for a module, or `{"enabled":true}` for a wall patch. Empty text or `null` means no argument.

```js
// Register this handler in the engineer's existing clientTools configuration.
async function roadsterCommand({ command, payloadJson = '' }) {
  try {
    const payload = payloadJson.trim() ? JSON.parse(payloadJson) : undefined;
    const result = await ui.dispatch(command, payload ?? undefined);
    return JSON.stringify({ ok: true, result: result ?? null, state: await ui.dispatch('getState') });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
}
```

## Existing commands

| Command | Payload / behavior |
| --- | --- |
| `getReadyState` / `getState` | Omitted; readiness / current state. |
| `loadTrajectory` | `{ version: 1, units: 'm', upAxis: 'Y', samples: [...] }`; validates, pauses at time zero, returns `{ samples, duration, warnings }`. |
| `play` / `pause` / `reset` | Omitted; resume / pause / return to time zero while keeping data. |
| `seek` | Finite seconds; clamps to the time range and pauses. |
| `setPlaybackRate` | Exactly `0.25`, `0.5`, `1`, or `2`; updates the existing selector. |
| `setVehicleScale` | Number `0.5…1.6`. |
| `setRampHeight` | Metres `12…32`. |
| `setWall` | Partial `{ enabled, x, height }`; boolean, X `-35…5` m, height `1…25` m. Width stays 8 m and thickness 0.35 m. |
| `setEntrySpeed` | Number `5…40` m/s; invalidates the previous experiment. |
| `setRampCurve` | Array of `{x,y}` metre coordinates; parks the car pending calculation. |
| `loadPhysicsResult` | Paired `{problemSpec,result}` from one solve; see [PHYSICS-AGENT.md](PHYSICS-AGENT.md). |
| `runTrial` / `adjustRamp` | Omitted; promises resolving after real local calculation. Trial requires a wall; adjustment requires a completed trial. |
| `compare` | `before`, `after`, or `compare`; selects the available result view. |
| `setView` | `scene`, `side`, or `car`. |
| `showModule` / `hideModule` | `scene-panel`, `edit-panel`, `motion-panel`, or `assets-panel`. |
| `moveModule` | `{ id, x, y }` in desk CSS pixels, constrained to the desk. |

Some actions return `undefined`; always await `ui.dispatch()` when sequencing commands. `getState()` retains module/playback fields and adds `busy`, `displayPosition`, `ramp`, `physics`, `experiment` and `selection`. `position` is now the raw solver point in physics mode; use `displayPosition` for the rendered vehicle centre. `overlapAtCurrentPose` is a compatibility field, not a whole-path clearance result; read `experiment.before.assessment` and `experiment.after.assessment`. GLB export remains direct `roadsterSim.exportGLB(kind)` only, excluded from the dispatcher and message bridge.

## Parameter feedback

`onParameters(change)` receives the local `roadster:parameters-changed` CustomEvent detail:

```js
{ type: 'roadster:parameters-changed', protocolVersion: 1, instanceId,
  revision: 7, source: 'ui', // or 'api'
  parameters: { vehicleScale: 1.1, rampHeight: 23, wall: { enabled: true, x: -18, height: 3 },
    entrySpeedMs: 22.2, rampCurve: [/* current input {x,y} points */] },
  changed: ['vehicleScale'] } // vehicleScale, rampHeight, wall, entrySpeedMs and/or rampCurve
```

Forward UI and API changes to the agent as state; do not echo the same setters back. Event `revision` matches state `parameterRevision`; `vehicleScale` corresponds to state `scale`. Before applying asynchronous work, compare its saved instance/revision with a fresh snapshot. Parameter events report input changes. `runTrial` and `adjustRamp` invoke the real local service; changing an input cancels stale calculations and clears the old comparison.

The same-origin `postMessage` bridge also remains available: `{ type: 'roadster:command', protocolVersion: 1, requestId, command, payload }`. Replies are `roadster:result` with `result`, or `roadster:error` with string `error` and `code`; both carry version, instance and request ID. Codes: `INVALID_REQUEST`, `UNSUPPORTED_VERSION`, `UNKNOWN_COMMAND`, `COMMAND_FAILED`. Validate source window and origin and send to the exact origin.

## Optional trajectory data

Renderer samples use `{ t, position: [x,y,z], quaternion: [qx,qy,qz,qw] }`. Use metres, seconds and a right-handed frame: +X forward, +Y up, +Z right. Position means the visual vehicle bounding-box center. Supply attitude for every sample or none; omitted attitude is inferred from the path. See `docs/TRAJECTORY.md`.

For paired physics data use `loadPhysicsResult({problemSpec,result})`; it constructs the matching ramp and retains raw solver coordinates with a separate display offset. The older `physicsResultToTrajectory()` helper remains for generic import compatibility, but does not align a ramp or run wall assessment. The local `/api/obstacle` route now performs live wall calculations; it is distinct from the repository's remote orchestrator/Daytona pipeline. Live phone streaming, speech routing and physical projector alignment still require the receiving engineer's implementation and validation.

## Complete wall sequence

```js
await ui.dispatch('setWall', {enabled:true, x:-18, height:3});
await ui.dispatch('runTrial');
await ui.dispatch('adjustRamp');
await ui.dispatch('compare', 'compare');
const {experiment} = await ui.dispatch('getState');
// Inspect after === null / search.status before announcing success.
```

Moving the wall or editing a curve/speed/scale clears the old result. Do not cache a successful assessment across parameter revisions. The solver is a simplified 2D model and clearance is a conservative visual car envelope; see [WALL-EXPERIMENT.md](WALL-EXPERIMENT.md) for limits.
