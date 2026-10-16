# Roadster / Projected Modules

Four movable, transparent control modules on the original desk photo: Model, Wall experiment, Motion and Files. An optional voice panel displays recognized English speech, the current action and its actual result. All controls and results stay inside the projected UI. The Roadster, original ramp assets and photo are preserved; dimensions are editable visual assumptions, not official CAD.

## Run

Requires Node.js 18+ and Python 3.9+ (`python3` on macOS/Linux, `python` on Windows). No pip packages or API keys are required for the local solver.

```sh
# From the repository root:
cd frontend/roadster
npm ci
npm run dev
```

Open `http://127.0.0.1:4178/`. For the downloaded ZIP, run `npm ci && npm run preview` in its extracted root; it already includes `dist/`. After source changes, run `npm run build` first. Dev and preview both provide `/api/obstacle`. **Static hosting alone cannot calculate the wall experiment.**

## Try the wall experiment

Click **Run** on the model to calculate and drive the original folded ramp, even without a wall. Add a wall or finish dragging it to automatically run the original path, stop at contact, adjust the ramp, recompute, and replay the before/after comparison. The original tall return bend stays in the model; when the wall blocks its join, a bounded fallback can move the join while retaining the bend's shape. The result reports both lift and bend movement.

Changed inputs cancel the old sequence. A clear original path is kept; a failed bounded search reports no solution. None of these actions select playback fixtures. Manual **Adjust ramp**, playback and comparison controls remain inside the projected modules.

[Wall workflow, API and model limits](docs/WALL-EXPERIMENT.md) · [Physics input/result adapter](docs/PHYSICS-AGENT.md)

## Connect the engineer's application

[Integration guide](docs/INTEGRATION.md) · [Calling example](examples/connect-roadster.js)

Use `/?embed=1` to remove the desk photo and place the transparent UI over the phone/FaceTime view with the existing `overlay/overlay.py`. Readiness events, parameter revisions, playback rate, direct calls and the same-origin message bridge remain available. The bridge also supports asynchronous `runTrial()` and `adjustRamp()` calls. The engineer owns the ElevenLabs microphone, conversation and intent routing, phone transport and physical projection calibration.

After the UI is ready, pass the actual recognized transcript and resolved action from the host's existing speech callback:

```js
async function onRecognizedCommand({ transcript, command, payload }) {
  return window.roadsterSim.runVoiceCommand({ transcript, command, payload });
}
function onVoicePhase(phase, transcript = '', detail = '') {
  return window.roadsterSim.setVoiceState({ phase, transcript, detail });
}
function onConversationEnded() {
  return window.roadsterSim.setVoiceState({ phase: 'idle' });
}
```

The optional panel shows **Working → Done / Needs adjustment / Error** from the awaited command and real solver result. `setVoiceState` accepts `idle`, `listening`, `thinking`, `speaking` and `error`; `idle` clears and hides the panel. `getState().voice` exposes `{phase, transcript, action, detail}`. These calls provide UI feedback; they do not capture audio or infer intent. See the [integration guide](docs/INTEGRATION.md) for complete browser dispatcher, ElevenLabs client-tool and pywebview callback examples.

The four stable control module IDs are `scene-panel`, `edit-panel`, `motion-panel`, `assets-panel`; `voice-panel` is optional and appears when the host supplies feedback. Titles drag, × closes, and the Model controls reopen the control modules. Voice feedback stays on the same desktop.

## Models and data

- `public/models/roadster-2026.glb`, `launch-ramp.glb`, `roadster-scene.glb`: preserved original GLB assets.
- `src/car.js`, `src/track.js`: editable original model definitions; `src/curve-track.js` constructs the current computed ramp.
- `public/backgrounds/desk-reference.png`: original supplied desk photo.
- [Model dimensions and coordinates](docs/MODEL-ASSETS.md) · [Trajectory CSV/JSON contract](docs/TRAJECTORY.md) · [Reference sources](references/SOURCES.md).
- [Solver provenance and wrapper changes](server/vendor/SOURCE.md).

The local solver is a frictionless 2D point/ballistic model. The continuous car-envelope check is conservative visualization geometry, not a tire, suspension or structural safety model. Legacy `public/examples/physics-*.json` are adapter samples; the wall workflow does not read them.

## Verify and package

```sh
npm run verify
python3 scripts/package-handoff.py
```

`verify` runs tests, build, preserved-asset hashes and actual GLB loading. Packaging creates `artifacts/roadster-ui-handoff.zip` containing source, built app, server, fixed Python solver, tests, docs, models and the desktop overlay launcher, with `SHA256SUMS.json`. Development dependencies and credentials are excluded.
