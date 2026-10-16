# Roadster UI

The same tabletop interface and four modules: Model, Edit, Motion, Files. UI, model geometry and assets are preserved. For integration, your application's full-screen phone video sits underneath the transparent `/?embed=1` UI.

## Open it

With the handoff ZIP, unzip and run:

```sh
python3 -m http.server 4180 --bind 127.0.0.1 --directory dist
```

Open **http://127.0.0.1:4180/**. This is the original product interface; no separate dashboard or debug page is included.

To develop from source (Node.js 20+):

```sh
cd frontend/roadster
npm ci
npm run dev
```

Open **http://127.0.0.1:4178/**. If that port is occupied, use `npm exec vite -- --host 127.0.0.1 --port 4180 --strictPort`.

## Connect voice and phone video

[Integration guide](docs/INTEGRATION.md) · [Calling example](examples/connect-roadster.js)

Your application receives the phone video and runs the ElevenLabs conversation. Display that video full-screen, place this UI's transparent iframe above it, and route voice tool calls to the existing UI methods. The guide includes the small HTML composition and calling code; there is no extra dashboard.

Three additions support integration: readiness, parameter-change callbacks, and playback-rate control. They add no visible controls. `loadTrajectory` remains available for the engineer's computed model motion. Phone streaming, ElevenLabs authentication and physics stay with the engineer's application.

Trajectory positions use metres, seconds, +X forward, +Y up and +Z right. Align the solver origin and center of mass with the model before loading real results.

## Reference

[Trajectory format](docs/TRAJECTORY.md) · [Model dimensions](docs/MODEL-ASSETS.md) · [Source references](references/SOURCES.md) · [Preservation hashes](docs/PRESERVED-ASSETS.json)

`npm run verify` checks tests, build and preserved assets. `npm run package:handoff` creates `artifacts/roadster-ui-handoff.zip` with the built app, source, docs, models and checksums. No credentials or development dependencies are bundled.
