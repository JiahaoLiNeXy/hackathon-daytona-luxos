# Video background + existing Roadster overlay

Display the phone's live tabletop video full-screen, with the existing transparent `/?embed=1` Roadster UI over it. The four product modules remain, with an optional draggable `voice-panel` for recognized speech, the current action and its result. The engineer supplies phone capture, ElevenLabs microphone/conversation handling and intent routing; this package executes UI commands and displays their feedback on the same desktop.

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

def roadster_voice_command(window, transcript, command, payload=None, *, on_result):
    # transcript is the actual recognized user speech, not generated agent text.
    return roadster_command(window, 'runVoiceCommand', {
        'transcript': transcript, 'command': command, 'payload': payload,
    }, on_result=on_result)

def roadster_voice_phase(window, phase, transcript='', detail='', *, on_result):
    return roadster_command(window, 'setVoiceState', {
        'phase': phase, 'transcript': transcript, 'detail': detail,
    }, on_result=on_result)

# After UI readiness, call roadster_voice_command from the existing finalized
# speech/intent callback with its real transcript and resolved command/payload.
# Call roadster_voice_phase from the real conversation lifecycle callbacks.
# phase='idle' clears the caption and hides the voice panel.
# Use on_result's reply, not evaluate_js's immediate return value.
# Start a dependent command only after its preceding callback succeeds.
```

`on_result` receives `{ok, result, state}` on completion or `{ok:false, error}` on failure. `ok:true` means the command returned; inspect the actual trial/adjustment result before claiming the wall cleared. This calling code belongs in the process that owns the window. Phone capture, speech recognition, intent selection and conversation transport stay with the engineer.

## If the engineer already receives video in a browser

Serve the Roadster build under `/roadster/` on the host's **same origin** and proxy `/api/obstacle` on that origin to the local UI service. The service accepts loopback hosts and same-origin calls; deploy it behind the host's local proxy rather than exposing a public solver. The following belongs in your host application; no product source or CSS change is needed:

```html
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
  #tabletop, #roadster { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  #tabletop { object-fit: cover; }
  #roadster { z-index: 1; background: transparent; mix-blend-mode: normal; }
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

## Show speech and action feedback

After `await ui.ready`, connect the engineer's real conversation callbacks to these functions:

```js
// phase: idle, listening, thinking, speaking or error.
async function onVoicePhase(phase, transcript = '', detail = '') {
  return ui.dispatch('setVoiceState', { phase, transcript, detail });
}

// Pass the finalized recognized user speech and the resolved existing command.
async function onRecognizedCommand({ transcript, command, payload }) {
  return ui.dispatch('runVoiceCommand', { transcript, command, payload });
}

async function onConversationEnded() {
  return ui.dispatch('setVoiceState', { phase: 'idle' });
}
```

`runVoiceCommand` requires a real, nonempty transcript and displays **Working** while awaiting the action. A wall trial or ramp adjustment becomes **Done** only for a traction-safe result with confirmed wall clearance; collision, lost traction or no feasible ramp becomes **Needs adjustment**. Command failures become **Error** and reject the call. The function returns the underlying action's result without replacing it with a success message. Always await dependent actions: a trial needs a wall, and adjustment needs a completed trial.

`setVoiceState` displays lifecycle information only; it does not start a microphone, recognize speech, choose an intent or execute a command. Each call replaces the caption; omitted `transcript`/`detail` become empty strings, and `idle` hides the panel. Both text fields are limited to 500 characters. A newer voice state or command prevents an older completion from replacing its caption; it does not cancel the underlying action. Report conversation phases when they actually occur, and retain the returned action result for the spoken response.

Await `runVoiceCommand` before setting `phase:'speaking'` to let its completion caption appear.

## If using ElevenLabs browser client tools

Register a client-side handler that forwards to this dispatcher. The configured tool name and parameter names are case-sensitive and must match the handler registration. Enable **Wait for response** so the conversation receives the actual execution result. [ElevenLabs client tools documentation](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools).

Configure `roadsterCommand` with required strings `transcript` and `command`, plus optional string `payloadJson`. Supply `transcript` from the actual finalized user transcription for that turn; never substitute a generated paraphrase, an agent reply or example speech. If the tool arguments do not preserve that source text, the host must bind the corresponding transcription before invoking this handler. `payloadJson` contains JSON: `0.5` for a rate, `"edit-panel"` for a module, or `{"enabled":true}` for a wall patch. Empty text or JSON `null` means no argument.

```js
// Register this handler in the engineer's existing clientTools configuration.
async function roadsterCommand({ transcript, command, payloadJson = '' }) {
  try {
    if (typeof transcript !== 'string' || !transcript.trim()) {
      throw new Error('The actual recognized user transcript is required.');
    }
    const payload = payloadJson.trim() ? JSON.parse(payloadJson) : undefined;
    const result = await ui.dispatch('runVoiceCommand', {
      transcript, command, payload: payload ?? undefined,
    });
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
| `setVoiceState` | `{ phase, transcript?, detail? }`; phase is `idle`, `listening`, `thinking`, `speaking` or `error`. Text fields are at most 500 characters. Returns the new voice state; `idle` hides the panel. |
| `runVoiceCommand` | `{ transcript, command, payload? }`; nonempty actual transcript, at most 500 characters. Awaits an existing action and returns its result; rejects failures. Excludes `getState`, `getReadyState`, `setVoiceState`, `runVoiceCommand` and `exportGLB` as nested commands. |
| `loadTrajectory` | `{ version: 1, units: 'm', upAxis: 'Y', samples: [...] }`; validates, pauses at time zero, returns `{ samples, duration, warnings }`. |
| `run` | Omitted; promise for the full current-input trial → original playback → adjustment (if blocked) → comparison playback sequence. Works without a wall too. |
| `play` / `pause` / `reset` | Omitted; play computes when no trajectory exists, otherwise resumes; pause holds playback; reset cancels the automatic sequence and returns to time zero. |
| `seek` | Finite seconds; clamps to the time range and pauses. |
| `setPlaybackRate` | Exactly `0.25`, `0.5`, `1`, or `2`; updates the existing selector. |
| `setVehicleScale` | Number `0.5…1.6`. |
| `setRampHeight` | Metres `12…32`. |
| `setWall` | Partial `{ enabled, x, height }`; boolean, X `-35…5` m, height `1…25` m. Width stays 8 m and thickness 0.35 m. |
| `setEntrySpeed` | Number `5…40` m/s; invalidates the previous experiment. |
| `setRampCurve` | Array of `{x,y}` metre coordinates; parks the car pending calculation. |
| `loadPhysicsResult` | Paired `{problemSpec,result}` from one solve; see [PHYSICS-AGENT.md](PHYSICS-AGENT.md). |
| `runTrial` / `adjustRamp` | Omitted; promises resolving after real local calculation. Trial works without a wall. Adjustment requires a wall and automatically runs the prerequisite trial if missing. |
| `compare` | `before`, `after`, or `compare`; selects the available result view. |
| `setView` | `scene`, `side`, or `car`. |
| `showModule` / `hideModule` | `scene-panel`, `edit-panel`, `motion-panel`, `assets-panel`, or optional `voice-panel`. Use `setVoiceState({phase:'idle'})` to clear and hide voice feedback. |
| `moveModule` | `{ id, x, y }` in desk CSS pixels, constrained to the desk. |

Some actions return `undefined`; always await `ui.dispatch()` when sequencing commands. `getState()` includes `voice: {phase, transcript, action, detail}` alongside the module/playback fields, `busy`, `displayPosition`, `ramp`, `physics`, `experiment` and `selection`. Voice phases also include action-generated `executing`, `done` and `attention`; callers cannot set those through `setVoiceState`. `position` is now the raw solver point in physics mode; use `displayPosition` for the rendered vehicle centre. `overlapAtCurrentPose` is a compatibility field, not a whole-path clearance result; read `experiment.before.assessment` and `experiment.after.assessment`. GLB export remains direct `roadsterSim.exportGLB(kind)` only, excluded from the dispatcher and message bridge.

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
await ui.dispatch('run'); // Includes original playback, adjustment and comparison playback.
const {experiment} = await ui.dispatch('getState');
// Inspect after === null / search.status before announcing success.
```

Moving the wall or editing a curve/speed/scale clears the old result. Do not cache a successful assessment across parameter revisions. The solver is a simplified 2D model and clearance is a conservative visual car envelope; see [WALL-EXPERIMENT.md](WALL-EXPERIMENT.md) for limits.

UI wall/speed edits trigger the sequence automatically after editing finishes. Programmatic setters remain parameter-only so the host can batch edits; call `run` once after them. `getState().workflow` reports testing, before, adjusting, after, complete, no-solution or error. Manual result selection or seeking cancels the automatic sequence.
