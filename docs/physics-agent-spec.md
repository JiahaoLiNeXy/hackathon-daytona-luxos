# Physics Agent — Technical Spec

## Position in the pipeline

```
Extraction Agent → Modeling Agent → Physics Agent → Narration Agent → Visualization
(raw perception)   (problem          (solve)         (summarize)      (render,
                     formulation,                                      non-agentic)
                     fills gaps)
```

The Physics Agent sits immediately downstream of the **Modeling Agent**. By
the time it receives a problem, all interpretation and gap-filling (scale
resolution, unit conversion, curve fitting, defaults, memory recall, spec
lookups) is already done. The Physics Agent never sees raw sketch pixels or
transcripts, and never decides what to assume — it only solves.

## Problem statement

> Reference case: the real-world Tesla Roadster uses a fan-powered suction
> system for downforce (letting it drive upside-down on a looping ramp) and
> compressed-air thrusters for mid-air flips and landing control — this is
> not a simple incline-and-launch ([sources](#reference)).

Given a ramp that may loop or invert (not just a simple incline), an entry
speed, a downforce capability, and a ground profile, determine two things:

1. **Does the car physically stay on the ramp?** At every point on the
   curve, the required centripetal force must not exceed what gravity's
   normal component plus the downforce/suction system can supply. This is
   the genuine "what physical parameters are needed" question — e.g. "at
   this speed, you need ≥X N of downforce to hold the loop."
2. **If it stays on and launches, what's the resulting trajectory?**
   Compute the ramp-phase trajectory and the subsequent airborne
   trajectory, and classify the outcome relative to the ground profile.

All physics on the **translational** (center-of-mass) trajectory is
closed-form (energy conservation on the ramp + projectile motion in the
air) — no iterative/numeric simulation. Rotational effects (the mid-air
flip/twist, thruster-assisted attitude control) are **explicitly out of
scope for the POC** — see Non-goals — and are rendered as a cosmetic
animation by Visualization, not computed here.

## Input contract (from Modeling Agent)

The Modeling Agent is responsible for producing this well-posed spec. Every
field is required and unambiguous — the Physics Agent does not apply
defaults or guess.

```json
{
  "ramp_curve_m": [
    {"x": 0.0, "y": 0.0},
    {"x": 2.0, "y": 0.8},
    {"x": 4.0, "y": 2.4},
    {"x": 5.2, "y": 3.6}
  ],
  "entry_speed_ms": 22.2,
  "car_mass_kg": 1300,
  "downforce_capability_n": 9000,
  "ground_profile": {
    "type": "gap",
    "landing_level_m": 0.0,
    "gap_start_x_m": 5.2,
    "gap_end_x_m": 12.0
  }
}
```

- `ramp_curve_m` — real-world-scaled (x, y) points along the ramp, already
  fit/smoothed by the Modeling Agent, in meters, ordered from ramp base to
  ramp exit (last point = launch point).
- `entry_speed_ms` — the car's speed at the first ramp point. This is the
  "speed X" parameter the user varies live via the UI slider — it is passed
  through the Modeling Agent unchanged, not derived by it.
- `car_mass_kg` — used in the traction check (step 2 below) and kept for
  future drag/mass-dependent effects.
- `downforce_capability_n` — maximum downforce/suction force (Newtons) the
  car's system can generate, used in the traction check. Sourced by the
  Modeling Agent (drawn/spoken annotation, a looked-up real spec, or a
  stated default) — the Physics Agent just consumes the number.
- `ground_profile.type` — one of `"flat"`, `"gap"`, `"lower_level"`. Defines
  what "landing" means for outcome classification.

## Responsibilities

1. **Validate the input** — confirm all required fields are present and
   numeric, `ramp_curve_m` has ≥2 points, `entry_speed_ms` > 0. Any
   violation is a hard failure (see Error Handling) — the Physics Agent does
   not patch or guess missing values; that would violate the upstream
   contract.

2. **Ramp phase (energy conservation, frictionless)**
   For each consecutive pair of ramp points, compute speed at each point
   using conservation of energy against the entry speed and cumulative
   height gain:
   `v_i = sqrt(v_entry² − 2·g·(y_i − y_0))`
   Time-parameterize each point using local speed and arc-length between
   points. Output one trajectory sample per input ramp point (phase =
   `"ramp"`).

3. **Traction/downforce check (the "loop" case)**
   At each interior ramp point, estimate local curvature `r_i` from its two
   neighbors and compute the centripetal force required to hold the car on
   the curve: `F_required = m·v_i² / r_i`. Compare against what's available:
   gravity's component normal to the curve plus `downforce_capability_n`.
   If `F_required` exceeds what's available at any point, the car loses
   contact with the ramp there — truncate the ramp trajectory at that
   point, mark `traction_ok: false` with the point/speed where it failed,
   and treat that point as an **uncontrolled departure** (feed its position
   and current velocity — not the full ramp exit's intended launch angle —
   into the flight phase as an uncontrolled ballistic start). If traction
   holds throughout, proceed normally.

4. **Determine launch conditions**
   At the last ramp point (or the traction-loss point from step 3): launch
   speed = local speed there, launch angle = tangent angle of the curve at
   that point (computed from the two nearest points), launch position =
   `(x, y)` at that point.

5. **Flight phase (projectile motion)**
   From launch conditions, sample the parabolic trajectory
   (`x(t) = x_exit + vx·t`, `y(t) = y_exit + vy·t − ½g t²`) until `y(t)`
   reaches the applicable landing level (flat/gap-far-side/lower-level per
   `ground_profile`). Output trajectory samples (phase = `"flight"`) at a
   fixed timestep (e.g. 0.02s) for smooth animation.

6. **Classify outcome** against `ground_profile` and the traction result:
   - If traction was lost (step 3): outcome is `"lost_traction"` regardless
     of where the resulting uncontrolled trajectory lands — the car never
     completed the intended maneuver, which is the physically interesting
     answer to "what parameters are needed."
   - Otherwise, against `ground_profile`:
     - `gap`: compare landing x to `gap_end_x_m` → `"cleared"` (margin > 0)
       or `"fell_short"` (crashes into the gap) with margin reported either
       way.
     - `flat` / `lower_level`: `"landed_normal"` once y reaches
       `landing_level_m`.

7. **Generate + execute solver code in Daytona**
   Steps 2–6 are implemented as a generated script (not a hardcoded
   function call) and run inside a Daytona sandbox. The agent's role is to
   produce this code from the input each time, execute it, and parse the
   sandbox's stdout/result back into the output contract below.

8. **Sanity-check the sandbox result** before returning — monotonic time,
   landing x beyond launch x, no NaNs. Failure here is a sandbox/execution
   error, not a silent correction.

## Output contract (handoff to Narration + Visualization)

`metrics.outcome` is one of: `"cleared"`, `"fell_short"`, `"landed_normal"`,
`"lost_traction"`. Note `"lost_traction"` is still a `status: "ok"` result —
it's a valid physics answer (the maneuver failed on the ramp, before any
ground-profile question even applies), not an agent error.

```json
{
  "status": "ok",
  "trajectory": [
    {"t": 0.0, "x": 0.0, "y": 0.0, "vx": 22.2, "vy": 0.0, "phase": "ramp"},
    {"t": 0.31, "x": 2.0, "y": 0.8, "vx": 20.9, "vy": 6.1, "phase": "ramp"},
    {"t": 0.58, "x": 5.2, "y": 3.6, "vx": 18.0, "vy": 13.4, "phase": "ramp"},
    {"t": 0.72, "x": 7.6, "y": 4.9, "vx": 18.0, "vy": 12.0, "phase": "flight"},
    {"t": 1.98, "x": 30.6, "y": 0.0, "vx": 18.0, "vy": -6.3, "phase": "flight"}
  ],
  "metrics": {
    "traction_ok": true,
    "max_required_downforce_n": 7400,
    "launch_angle_deg": 36.7,
    "launch_speed_ms": 18.9,
    "hang_time_s": 1.26,
    "max_height_m": 5.1,
    "landing_x_m": 30.6,
    "outcome": "cleared",
    "margin_m": 18.6
  },
  "execution": {"duration_ms": 340, "sandbox_id": "sbx_abc123"},
  "error": null
}
```

On failure:

```json
{
  "status": "error",
  "trajectory": [],
  "metrics": null,
  "execution": {"duration_ms": 120, "sandbox_id": "sbx_abc123"},
  "error": {
    "code": "invalid_input" | "sandbox_execution_failed" | "result_sanity_check_failed",
    "message": "human-readable reason"
  }
}
```

## Error handling

| Failure | Response |
|---|---|
| Missing/malformed input field | `status: "error"`, `code: "invalid_input"` — no guessing, no defaults |
| Daytona sandbox execution throws / times out | `status: "error"`, `code: "sandbox_execution_failed"` |
| Result fails sanity checks (NaN, non-monotonic time, etc.) | `status: "error"`, `code: "result_sanity_check_failed"` |
| No retries, no fallback simulation | Orchestrator decides what to show the user (e.g. "couldn't compute this one — try adjusting the drawing") |

## Non-goals (explicitly out of scope)

- Interpreting or re-deriving ramp geometry — that's the Modeling Agent's job; this agent treats `ramp_curve_m` as ground truth.
- Friction, drag, suspension, tire grip — frictionless point-mass model only, for the POC.
- **Rotational dynamics** — the mid-air flip/twist and any thruster-assisted
  attitude control are not simulated. The Physics Agent only computes the
  center-of-mass (translational) trajectory; flips are a cosmetic animation
  applied by Visualization on top of the real trajectory, not a physical
  output of this agent.
- **Thruster net-force contribution to flight-phase translation** — the
  flight phase is treated as pure ballistic (free-fall) motion. Real
  thruster-assisted translation during flight is ignored for the POC; this
  is a known simplification, not an oversight.
- Deciding what's worth narrating — Narration Agent's job.
- Rendering — Visualization's job.
- Persisting results to SurrealDB — orchestrator's job, as a side effect of the direct handoff.
- Any iterative/numeric physics simulation — strictly closed-form kinematics.

## Open items

- Exact Daytona invocation pattern (one sandbox per request vs. a warm reusable sandbox) — affects `execution.duration_ms` and demo latency; needs a quick spike to see cold-start cost.
- Timestep for the flight-phase trajectory (0.02s assumed above) may need tuning against the Visualization layer's frame rate.
- Source of `downforce_capability_n` — whether the Modeling Agent derives this from a drawn/spoken annotation, a looked-up real Tesla spec (anchorbrowser), or a stated default — is the Modeling Agent's decision, not this agent's; needs to be defined in the Modeling Agent spec.

## Reference

The ramp-loop + traction-check framing is grounded in Tesla's October 2026
Roadster unveiling at a SpaceX facility in McGregor, TX: the car drove
upside-down on a looping ramp using a fan-powered suction downforce system,
then used 10 compressed-air thruster nozzles to flip and land, jumping over
a lineup of vehicles including a Semi and Cybertruck.

- [Tesla unveils new Roadster that can flip in the air and land using rocket-style thrusters](https://www.theglobeandmail.com/business/international-business/article-tesla-new-roadster-turns-in-air-with-spacex-thrusters/)
- [Tesla's new Roadster takes flight during dramatic unveiling at SpaceX facility](https://www.foxbusiness.com/technology/teslas-new-roadster-makes-flying-debut-hitting-60-mph-under-second)
- ['Something extraordinary': Tesla Roadster wows with compressed air thrusters for limited flight](https://finance.yahoo.com/markets/stocks/article/tesla-unveils-roadster-featuring-compressed-air-thrusters-for-limited-flight-015532745.html)
- [Tesla reveals SpaceX-powered Roadster that flies and falls with style](https://techcrunch.com/2026/10/15/tesla-reveals-spacex-powered-roadster-that-flies-and-falls-with-style/)
