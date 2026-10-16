# Modeling Agent — Technical Spec

## Position in the pipeline

```
Extraction Agent → Modeling Agent → Physics Agent → Visualization
(raw perception)   (problem          (solve)         (render + narrate,
                     formulation,                     non-agentic)
                     fills gaps)
```

The Modeling Agent is the only place in the pipeline where physical-world
judgment happens: interpreting ambiguous sketch geometry, resolving scale,
deciding what to assume, and deciding when to look something up instead of
guessing. Extraction stays "dumb" (pure perception, no physics knowledge);
the Physics Agent stays purely mechanical (no judgment at all — see
[physics-agent-spec.md](./physics-agent-spec.md)). This agent is the hinge
between them.

## Problem statement

Given raw, ambiguous perceptual output — digitized sketch curves in pixel
space, OCR'd labels, a voice transcript, and whatever the Extraction Agent
could pull out without any physics interpretation — produce a single,
complete, unambiguous problem spec that exactly matches the Physics Agent's
input contract. Every required field must be filled, with its origin
(drawn, spoken, recalled from memory, looked up, or assumed default) tracked
for transparency, even though the Physics Agent itself never sees that
tracking.

## Input contract (from Extraction Agent)

Extraction performs no interpretation — it only digitizes and transcribes.

```json
{
  "sketch": {
    "curves": [
      {"id": "c1", "points_px": [[40, 320], [120, 280], [210, 190], [260, 140]]},
      {"id": "c2", "points_px": [[260, 300], [520, 300]]}
    ],
    "grid_detected": {"present": true, "spacing_px": 42},
    "labels_text": ["60 mph"]
  },
  "voice_transcript": "the car races up this loop and flies over the trucks at about 60 miles an hour",
  "mentioned_entities": ["Tesla Roadster", "trucks"],
  "mentioned_quantities": [
    {"text": "60 miles an hour", "value": 60, "unit": "mph"}
  ]
}
```

- `sketch.curves` — every distinct stroke/curve detected, in raw pixel
  coordinates, with no semantic label (Extraction doesn't know which curve
  is the ramp vs. the ground vs. a stray mark).
- `grid_detected` — if a reference grid is visible on the paper, its pixel
  spacing; `null` if none detected. No real-world scale is implied yet.
- `labels_text` — any handwritten text OCR'd verbatim, unstructured.
- `voice_transcript` — raw STT output (ElevenLabs), unparsed.
- `mentioned_entities` / `mentioned_quantities` — simple NLP extraction
  (named things, numbers-with-units) with no resolution to physics fields.

## Responsibilities

1. **Resolve scale (pixels → meters).**
   Use `grid_detected.spacing_px` plus a real-world grid size (from a
   spoken/written legend, e.g. "each square is 2 meters" in
   `labels_text`/`voice_transcript`) to compute a px→m conversion factor.
   If no grid or legend is found, fall back to an **assumed default scale**
   and tag it as such — never block on missing scale.

2. **Classify curves.**
   Decide which curve is the ramp and which (if any) represents the ground
   after the ramp / a gap / a lower level. For the POC this can be a simple
   heuristic (the curve connected to or continuing from the ramp's exit is
   ground; curves disconnected and offset downward imply a gap) backed by
   an LLM call for ambiguous cases. Tag the decision's confidence; this is
   the step most likely to need iteration once real sketches are tested.

3. **Build `ramp_curve_m`.**
   Convert the chosen ramp curve's pixel points to meters using the scale
   factor, order them from base to exit, and smooth/resample so the Physics
   Agent gets a clean, evenly-spaced point list (not raw noisy strokes).

4. **Build `ground_profile`.**
   From the classified ground/gap curve (or its absence → default flat
   ground at the ramp's base level), determine `type` (`flat`/`gap`/
   `lower_level`) and its associated distances, in meters via the same
   scale factor.

5. **Resolve `entry_speed_ms`.**
   If `mentioned_quantities` includes a speed, convert it to m/s and use it
   as the **initial default** for the UI's speed slider. Once the user is
   dragging the slider, the orchestrator passes that value straight to the
   Physics Agent on each tick — see Open Items on why Modeling doesn't
   re-run per tick.

6. **Resolve `car_mass_kg` and `downforce_capability_n`.**
   In order of preference: (a) explicit value drawn/spoken, (b) recalled
   from SurrealDB session memory (e.g., "Tesla Roadster" was already
   resolved earlier this session), (c) looked up via anchorbrowser against
   a real spec for a named entity in `mentioned_entities`, (d) a stated
   assumed default. Always tag which path was used.

7. **Validate well-posedness.**
   Confirm the resulting spec has ≥2 ramp points, a valid `ground_profile`,
   and positive `entry_speed_ms`/`car_mass_kg`/`downforce_capability_n`. If
   Extraction's input is too sparse to proceed at all (e.g. zero curves
   detected), return an error rather than fabricating geometry from
   nothing.

## Tools

- **SurrealDB (read only)** — recall prior-turn scenario values (e.g. car
  spec) within the session. The Modeling Agent reads memory; it does not
  write it — persistence after each stage is the orchestrator's
  responsibility (direct-handoff design, memory as a side effect, not the
  primary channel).
- **anchorbrowser (stretch)** — look up a real-world spec for a named
  entity when no drawn/spoken/recalled value exists. Must have a fast
  fallback to an assumed default if the lookup is slow, fails, or is
  unavailable — never block the pipeline on it.

## Output contract (handoff to Physics Agent)

Two parts: the clean `problem_spec` (exactly the Physics Agent's input
contract, no metadata) and a parallel `sources` map for the UI/narration
layer and debugging — the Physics Agent only ever sees `problem_spec`.

```json
{
  "status": "ok",
  "problem_spec": {
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
  },
  "sources": {
    "ramp_curve_m": "drawn",
    "entry_speed_ms": "spoken",
    "car_mass_kg": "looked_up:tesla_roadster_2026",
    "downforce_capability_n": "assumed_default",
    "ground_profile": "drawn"
  },
  "error": null
}
```

On failure:

```json
{
  "status": "error",
  "problem_spec": null,
  "sources": null,
  "error": {
    "code": "insufficient_input",
    "message": "No ramp-like curve detected in the sketch."
  }
}
```

## Error handling

| Failure | Response |
|---|---|
| No curves detected at all | `status: "error"`, `code: "insufficient_input"` |
| Curve classification too ambiguous to pick a ramp (e.g. 5+ overlapping curves) | `status: "error"`, `code: "insufficient_input"` — don't guess at a wrong ramp |
| anchorbrowser lookup fails/times out | Fall back to assumed default, tag `source` accordingly — not an error |
| SurrealDB memory read fails | Fall back to no-memory path (treat as first turn), not an error |

## Non-goals (explicitly out of scope)

- Digitizing the sketch or transcribing audio — Extraction's job; this agent assumes that's already done.
- Any physics computation (energy conservation, projectile motion, traction checks) — Physics Agent's job.
- Rendering or narrating — downstream agents' jobs.
- Writing to SurrealDB — orchestrator's job; this agent only reads.

## Open items

- **Live slider latency.** Re-running the full Modeling Agent (possibly including an LLM call) on every speed-slider tick would be too slow for a live demo. Current assumption: Modeling runs once per sketch/voice update to produce the full `problem_spec`, and the orchestrator patches just `entry_speed_ms` directly into subsequent Physics Agent calls without re-invoking Modeling. Needs validation once the UI is built.
- **Curve classification heuristic vs. LLM call** — start with simple heuristics (position/continuity), escalate to an LLM call only for ambiguous cases, to keep latency and cost down.
- **Scale legend format** — what exact phrasing/notation users are expected to draw or say for "1 square = 2m" needs a decision so extraction/modeling can reliably parse it.
