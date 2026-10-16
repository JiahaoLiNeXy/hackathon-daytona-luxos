# Paper-to-Screen: Technical Plan

## Product Background

People sketch physical scenarios on paper (a road, a ramp, a car) and describe
them out loud. Today that sketch stays a static drawing — there's no way to
ask "is this plausible?" or "what happens if the car goes faster?" without
manually doing the physics.

This project turns that paper sketch into a live digital twin: capture the
drawing and the verbal description, extract a structured physical scenario,
solve the physics, and render an animated visualization that answers
open-ended "what happens at speed X?" questions — live, while the user is
still drawing.

**Hero demo:** a Tesla Roadster races up a curved ramp, launches off the end,
and flies through the air to land on the ground beyond. The user draws the
road/ramp, describes the car, and can dial in a launch speed to see the
resulting trajectory (clears the gap / falls short / overshoots).

## Architecture: Three Layers

```
INPUT                 PROCESSING                      OUTPUT
-----                 ----------                       ------
photo (interval)  →   Extraction Agent   →   Physics Agent   →   Visualization
voice (STT)            (structures the        (solves the         (renders
                         scenario)              trajectory in       trajectory,
                                                 a Daytona           narrates
                                                 sandbox)            result)
```

Orchestration is a **plain (non-agentic) pipeline**: Extraction → Physics →
Narration, direct handoff between stages. No LLM-driven re-planning — a fixed
sequence is more reliable for a live demo. Each stage's input/output is
persisted to SurrealDB as a side effect, not as the primary communication
channel.

## Agents

### 1. Extraction Agent
- **Input:** latest photo(s) of the sketch + voice transcript (ElevenLabs STT).
- **Job:** produce a structured scenario JSON — ramp angle, launch height,
  ground level/gap, car spec, launch speed (if given) — each field tagged
  with its `source`: `"drawn"`, `"spoken"`, `"assumed_default"`, or
  `"looked_up"`.
- **Tools:**
  - SurrealDB — read prior scenario/session memory (e.g., car spec from an
    earlier turn), so the user can redraw just the ramp.
  - anchorbrowser *(stretch)* — look up a real spec (e.g. Tesla Roadster
    curb weight) when a value is missing, instead of guessing.
- **Why agentic:** it decides *when* to assume vs. look up vs. recall from
  memory — that's a judgment call, not a fixed function.

### 2. Physics Agent
- **Input:** structured scenario JSON + a launch speed parameter (user-set,
  via slider — "what happens at speed X").
- **Job:** write a small kinematics/projectile-motion script and execute it
  in a **Daytona sandbox**, returning a trajectory array (x, y over time) and
  derived metrics (hang time, max height, landing point, clears/falls-short).
- **Why agentic + sandboxed:** the agent generates the solving code itself
  rather than calling a hardcoded function, and runs it in an isolated
  Daytona sandbox rather than in-process — this is the core "agent sandbox"
  story for the demo.
- **Physics scope (POC):** closed-form only — incline/ramp exit angle,
  projectile motion for the airborne phase. No physics engine, no
  iterative simulation.

### 3. Narration Agent (thin, optional)
- **Input:** trajectory + metrics from the Physics Agent.
- **Job:** decide what's worth saying ("clears the gap by 1.2m" vs. "falls
  1.5m short") and narrate it via **ElevenLabs TTS**.
- **Why agentic (lightly):** it picks *what* to highlight, not just reads a
  fixed template.

### Visualization — not an agent
- Deterministic renderer (2D canvas) that consumes the trajectory JSON and
  draws the ramp/ground (from extracted geometry) + the car's path.
  Exposes the speed slider that re-triggers the Physics Agent.
- Kept non-agentic so animation is always correct and fast — no LLM in the
  render path.

## Sponsor Tech Mapping

| Product | Layer | Role |
|---|---|---|
| **ElevenLabs** | Input / Output | STT for voice description capture; TTS for Narration Agent's spoken summary |
| **Daytona** | Processing | Sandbox execution of the Physics Agent's generated solving code |
| **SurrealDB** | Processing (cross-cutting) | Persists each workflow run (scenario, trajectory, result) for session memory and later optimization/analysis |
| **Arize** | Processing (cross-cutting) | Tracing/observability on the Extraction and Physics Agent calls — judge-facing trace view |
| **anchorbrowser** | Processing (stretch) | Extraction Agent looks up real-world specs instead of assuming defaults |

## Data Flow (per turn)

1. Photo + voice captured → sent to **Extraction Agent**.
2. Extraction Agent reads prior session state from **SurrealDB**, produces
   structured scenario JSON (tagged sources), writes it back to SurrealDB.
3. User sets/adjusts launch speed via UI slider.
4. **Physics Agent** takes scenario + speed → generates + runs solver code
   in **Daytona** → returns trajectory + metrics → persisted to SurrealDB.
5. **Visualization** renders the trajectory immediately.
6. **Narration Agent** (optional) summarizes the result via ElevenLabs TTS.
7. All steps traced via **Arize** for the observability panel.

## Build Priority (if time-constrained)

1. **Core path, no sponsors:** photo+voice → extraction (hardcoded prompt) →
   hardcoded physics function → canvas render. Get this working end-to-end
   first.
2. **Daytona:** move the physics solve into agent-generated code run in a
   sandbox.
3. **ElevenLabs:** add STT on input, TTS on output.
4. **SurrealDB:** add session persistence/memory.
5. **Arize:** add tracing for the demo's observability panel.
6. **anchorbrowser:** cut first if behind schedule; nice-to-have only.

## Key Risks

- **Sketch → geometry extraction accuracy** (ramp angle, gap distance) is the
  hardest part. Mitigate by constraining the sketch vocabulary (grid with a
  stated scale, limited road primitives) rather than fully freeform drawing.
- **Units:** need an explicit scale (e.g., "1 grid square = 2m," spoken or
  drawn) or absolute distances are meaningless.
- **Latency:** multi-agent chain (extraction → sandbox exec → render) must
  stay fast enough for a live demo feel; consider a manual "analyze" trigger
  rather than continuous polling.
- **Scope creep on physics:** stay strictly closed-form (incline + projectile
  motion). No iterative/numeric simulation engine for the POC.
