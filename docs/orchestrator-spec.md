# Orchestrator — Technical Spec

## Position in the pipeline

```
         ┌─────────────────────────────────────────────────┐
         │                  Orchestrator                    │
         │   (plain code — not an agent, not an LLM call)    │
         └─────────────────────────────────────────────────┘
Input →  Extraction Agent → Modeling Agent → Physics Agent → Visualization
                                                                (renders + narrates)
```

The orchestrator is deliberately **not agentic**. It's a fixed, predictable
sequencer — reliability for a live demo matters more here than flexibility.
All the judgment/reasoning lives inside the agents; the orchestrator just
calls them in order and moves data between them (direct handoff, per our
earlier decision — agents don't talk to each other or to SurrealDB directly
except where noted).

## Problem statement

Something has to: sequence the three agent calls, hold the current session's
state between calls, decide which agents actually need to run for a given
trigger (a brand-new sketch vs. just a speed-slider move), and surface
whatever error/result comes out the other end to the UI. That's the
orchestrator's entire job — nothing physics- or perception-related belongs
here.

---

## V0 — simple and basic

Build this first. No persistence, no tracing, no concurrency handling
beyond "one request at a time." Just prove the chain works end to end.

### State

A single in-memory object per session:

```json
{
  "session_id": "s1",
  "problem_spec": { /* last Modeling Agent output, or null */ },
  "sources": { /* last Modeling Agent sources map, or null */ },
  "last_result": { /* last Physics Agent output, or null */ }
}
```

No database. If the process restarts, session state is gone — acceptable
for a demo.

### Two triggers

**1. `process_capture(photo, voice_transcript)`** — full chain, run on a new
sketch/voice update:

```
extraction_out = ExtractionAgent.run(photo, voice_transcript)
modeling_out   = ModelingAgent.run(extraction_out, memory=None)   # V0: no SurrealDB yet
physics_out    = PhysicsAgent.run(modeling_out.problem_spec)

state.problem_spec = modeling_out.problem_spec
state.sources      = modeling_out.sources
state.last_result  = physics_out

return { problem_spec, sources, physics_out }
```

Narration is Visualization's responsibility (a fixed rule/template over
`physics_out.metrics`, not a separate agent call) — the orchestrator just
hands `physics_out` to it along with the trajectory.

**2. `update_speed(new_speed_ms)`** — fast path, run on every slider move:

```
if state.problem_spec is None:
    return error("no scenario loaded yet")

patched_spec = { ...state.problem_spec, entry_speed_ms: new_speed_ms }
physics_out  = PhysicsAgent.run(patched_spec)

state.last_result = physics_out

return { physics_out }
```

This is the direct mechanism behind the latency concern flagged in the
Modeling Agent spec: the slider never re-triggers Extraction or Modeling.

### Error handling (V0)

Each agent returns `{status: "ok" | "error", ...}`. The orchestrator does
**no retries** (per every agent spec). On the first `status: "error"` in
the chain, stop and return it immediately with which stage failed:

```json
{
  "status": "error",
  "failed_stage": "modeling",
  "error": { "code": "insufficient_input", "message": "..." }
}
```

Note: `"lost_traction"` from the Physics Agent is **not** an error — it's a
normal `status: "ok"` result with an interesting outcome. The orchestrator
passes it through unchanged to Visualization, which renders and narrates it
like any other outcome.

### Non-goals for V0

- No SurrealDB persistence (Modeling Agent's memory-read tool gets `None`/empty for now — it just falls back to no-memory behavior, which the Modeling spec already defines as non-error).
- No Arize tracing.
- No concurrency handling — single in-flight request, synchronous, blocking.
- No retries or fallback simulation on any agent failure.

---

## V1 — add persistence + observability

Once V0 works end to end:

1. **SurrealDB writes** — after each successful stage, write its output
   (`extraction_out`, `modeling_out`, `physics_out`) to SurrealDB, keyed by
   `session_id` + a turn counter. This is a side effect the orchestrator
   performs — agents still never write memory themselves.
2. **SurrealDB read for Modeling** — pass the session's prior
   `modeling_out` (or relevant fields) into `ModelingAgent.run(..., memory=...)`
   so cross-turn recall (e.g. "remember the car spec from last turn") works.
3. **Arize tracing** — wrap each `*Agent.run(...)` call with a trace
   span (inputs, outputs, latency, status). Purely additive — doesn't
   change control flow.

---

## Interfaces (for the UI to call)

```
POST /session/{id}/capture   body: { photo, voice_transcript }  → full chain result
POST /session/{id}/speed     body: { speed_ms }                 → fast-path result
GET  /session/{id}/state     →  current problem_spec/sources/last_result (for reload)
```

`GET /session/{id}/state` is V0-trivial since it's just reading the
in-memory object; becomes a SurrealDB read once V1 lands.

## Open items

- Should Visualization re-narrate (ElevenLabs TTS) on every `update_speed`
  tick, or only on slider-release? Affects call volume and whether the
  spoken summary feels laggy/repetitive during a drag — this now lives
  entirely on the Visualization side, not the orchestrator's, since there's
  no separate narration call to throttle here.
- Single-session vs. multi-session — V0 can assume exactly one active
  session for the demo; multi-session support (the `session_id` plumbing
  above) is included now so it's not a breaking change later, but isn't
  being exercised yet.
