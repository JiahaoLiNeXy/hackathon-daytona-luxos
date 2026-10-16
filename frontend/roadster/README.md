# Roadster / Projected Modules

Four movable, transparent modules on the original desk photo: Model, Wall experiment, Motion and Files. All controls and results stay inside the projected UI. The Roadster, original ramp assets and photo are preserved; dimensions are editable visual assumptions, not official CAD.

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

Click **放墙 → 试跑 → 调整跑道 → 对比**. Drag the wall in the model or edit its position/height. The first run uses the current ramp; the car stops at the first conservative wall contact. Adjustment generates candidate ramps from the current inputs, runs the Physics Agent's fixed Python solver again, and checks the complete moving car envelope. Comparison overlays both paths in one coordinate system. Changed inputs invalidate results; a failed search reports no solution.

The default wall at X = −18 m, height = 3 m produces a visible before/after. Moving it to −15 m demonstrates a no-solution result in the bounded search because the returning flight can hit the wall. These are computed inputs, not selected playback fixtures.

[Wall workflow, API and model limits](docs/WALL-EXPERIMENT.md) · [Physics input/result adapter](docs/PHYSICS-AGENT.md)

## Connect the engineer's application

[Integration guide](docs/INTEGRATION.md) · [Calling example](examples/connect-roadster.js)

Use `/?embed=1` to remove the desk photo and place the transparent UI over the phone/FaceTime view with the existing `overlay/overlay.py`. Readiness events, parameter revisions, playback rate, direct calls and the same-origin message bridge remain available. The bridge also supports asynchronous `runTrial()` and `adjustRamp()` calls. Phone transport, speech intent routing and physical projection calibration remain the host application's responsibility.

The four stable module IDs are `scene-panel`, `edit-panel`, `motion-panel`, `assets-panel`. Titles drag, × closes, and the Model controls reopen modules. No outer debug toolbar is added.

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
