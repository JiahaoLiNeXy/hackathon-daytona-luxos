# Physics Agent rendering contract

The wall workflow is documented in [WALL-EXPERIMENT.md](WALL-EXPERIMENT.md). This page describes importing an engineer's ramp and paired solver output. The old `physics-handoff.html` URL redirects to the same projected desktop.

## Curve preview and paired result

```js
const sim = window.roadsterSim;
sim.setRampCurve(problemSpec.ramp_curve_m);
// Preview the supplied geometry, discard the previous result, park the car.
sim.loadPhysicsResult({ problemSpec, result });
// Load the matching solver output and pause at its start.
sim.play();
```

`setRampCurve([{x,y}, ...])` preserves metres, point order and coordinates. It constructs a solid deck, red edges, white centre line and visual supports from consecutive segments. Rendering accepts 2–50,000 valid points; the local live solver has a stricter 1,000-point limit. Invalid geometry is rejected before replacing the scene. Curve preview has no playable trajectory.

`loadPhysicsResult({problemSpec,result})` validates and loads both together. The caller must provide the actual matching input: the upstream result contains no geometry or request ID that could independently prove the pair. `status: "error"` rejects without substituting a demo. `status: "ok"` may still have `metrics.outcome: "lost_traction"`.

`problemSpec` contains `ramp_curve_m`, `entry_speed_ms`, `car_mass_kg`, `downforce_capability_n` and `ground_profile`. `result` retains `status`, `trajectory`, `metrics`, `execution` and `error`. Rendering supports the upstream flat/gap/lower-level ground records; the bundled wall search supports flat ground only.

## Position and attitude

- Right-handed metres/seconds: +X forward, +Y up, +Z right.
- Solver `{t,x,y,vx,vy,phase}` becomes renderer `[x,y,0]`; `getState().position` and the trajectory line keep this raw position.
- `getState().displayPosition` is the rendered car centre. Physics/curve display adds half the scaled car height plus 0.04 m along its local +Y to keep the body above the deck. That offset does not alter the solver output.
- Heading comes from `atan2(vy,vx)`, retaining the preceding heading at zero speed. It is a visualization, not simulated rotational dynamics.
- Imported generic CSV/JSON trajectories use their supplied vehicle-centre positions without this compensation; see [TRAJECTORY.md](TRAJECTORY.md).

The original vehicle, track definitions, published GLBs and background are unchanged. `exportGLB('ramp')` exports the currently displayed curve, while the published default GLBs remain the originals.

## Host integration

The ready signal, `getReadyState()`, direct API and same-origin `roadster:command` transport are described in [INTEGRATION.md](INTEGRATION.md). Both curve and result methods are allowlisted. Loading a new curve or result invalidates previous wall comparisons. Imported results alone do not certify wall clearance; run the wall experiment to calculate that assessment.

Legacy JSON files under `public/examples/physics-*.json` are retained for adapter checks. They are not loaded by **试跑** or **调整跑道**. Live calls execute the bundled fixed Python solver and return fresh `local-live-*` execution identifiers. See [solver provenance](../server/vendor/SOURCE.md) for the upstream revision, wrapper diff and calculation limits.
