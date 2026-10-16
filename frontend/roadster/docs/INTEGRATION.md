# Video background + existing Roadster overlay

The host displays the phone's live tabletop video full-screen, with the existing transparent `/?embed=1` Roadster UI over it. Keep the four product modules and their styles. The receiving engineer supplies the video stream, ElevenLabs session and authentication; this package supplies the UI commands and feedback, without an additional control page.

## Host composition

Serve the Roadster build under `/roadster/` on the host's **same origin**. The following belongs in your host application; no product source or CSS change is needed:

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

`connectRoadster` uses `window.roadsterSim`, `getReadyState()` and local CustomEvents. It allows only the 15 existing message commands, forwards API errors and returns their real results. Calls before readiness or after disconnection fail explicitly. For a late caller, `ui.getReadyState()` returns `{ ready, protocolVersion: 1, instanceId, state, commands }` without needing another ready event.

## ElevenLabs client tool

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
| `setWall` | Partial `{ enabled, x, height }`; boolean, X `-40…10` m, height `1…30` m. |
| `setView` | `scene`, `side`, or `car`. |
| `showModule` / `hideModule` | `scene-panel`, `edit-panel`, `motion-panel`, or `assets-panel`. |
| `moveModule` | `{ id, x, y }` in desk CSS pixels, constrained to the desk. |

Some actions return `undefined`. `getState()` reports `modules`, `time`, `duration`, `playing`, `playbackRate`, `parameterRevision`, trajectory `source`, `position`, `quaternion`, `scale`, `rampHeight`, `wall`, `overlapAtCurrentPose` and `view`. GLB export remains direct `roadsterSim.exportGLB(kind)` only, excluded from the dispatcher and message bridge.

## Parameter feedback

`onParameters(change)` receives the local `roadster:parameters-changed` CustomEvent detail:

```js
{ type: 'roadster:parameters-changed', protocolVersion: 1, instanceId,
  revision: 7, source: 'ui', // or 'api'
  parameters: { vehicleScale: 1.1, rampHeight: 23, wall: { enabled: true, x: -18, height: 12 } },
  changed: ['vehicleScale'] } // vehicleScale, rampHeight and/or wall
```

Forward UI and API changes to the agent as state; do not echo the same setters back. Event `revision` matches state `parameterRevision`; `vehicleScale` corresponds to state `scale`. Before applying asynchronous work, compare its saved instance/revision with a fresh snapshot. The adapter runs no solver, mock or delayed work.

The same-origin `postMessage` bridge also remains available: `{ type: 'roadster:command', protocolVersion: 1, requestId, command, payload }`. Replies are `roadster:result` with `result`, or `roadster:error` with string `error` and `code`; both carry version, instance and request ID. Codes: `INVALID_REQUEST`, `UNSUPPORTED_VERSION`, `UNKNOWN_COMMAND`, `COMMAND_FAILED`. Validate source window and origin and send to the exact origin.

## Optional trajectory data

Renderer samples use `{ t, position: [x,y,z], quaternion: [qx,qy,qz,qw] }`. Use metres, seconds and a right-handed frame: +X forward, +Y up, +Z right. Position means the visual vehicle bounding-box center. Supply attitude for every sample or none; omitted attitude is inferred from the path. See `docs/TRAJECTORY.md`.

The optional `physicsResultToTrajectory()` maps repository `PhysicsResult.trajectory[]` (`{ t,x,y,vx,vy,phase }`) to `[x,y,0]`, preserving XY/time without inventing attitude. Align solver origin, ramp and center of mass with the visual center explicitly; this does not guarantee alignment with the default ramp. Scene edits do not recompute imported trajectories. The Python/CLI backend's proposed HTTP routes are not implemented or connected here. Live phone streaming, ElevenLabs operation and real backend end-to-end integration still require the receiving engineer's implementation and validation.
