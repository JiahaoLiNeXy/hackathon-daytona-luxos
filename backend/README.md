# Backend (POC)

Minimal V0 orchestrator (see `../docs/orchestrator-spec.md`) wired to a real
Modeling Agent (see `../docs/modeling-agent-spec.md`) and a real Physics
Agent (see `../docs/physics-agent-spec.md`).

Extraction Agent isn't built yet — `mock_extraction.py` stands in for it.

## Setup

```bash
cd backend
uv venv .venv && source .venv/bin/activate
uv pip install -r requirements.txt
```

## Daytona (optional)

The Physics Agent runs its generated solver code through a sandbox. By
default (no credentials) it uses `LocalSubprocessExecutor` — a real OS
subprocess, isolated from the backend process, but not a real sandbox.

To use a real Daytona sandbox instead, create `backend/.env` (gitignored,
never commit it) with:

```
DAYTONA_API_KEY=...
DAYTONA_API_URL=...   # optional, SDK has a default
```

`PhysicsAgent` picks Daytona automatically whenever `DAYTONA_API_KEY` is
set (see `default_executor()` in `code_executor.py`) — no code change
needed to switch.

## Run

```bash
python3 run_demo.py
```

Runs the full Modeling → Physics chain (plus the `update_speed` fast path)
against two mocked scenarios: a fully-specified loop (grid+legend, spoken
speed/entity — this one loses traction on the mocked sketch's sharp first
curve, which is a real result, not a bug) and a sparse sketch exercising
every `assumed_default` fallback.

## Files

- `schemas.py` — dataclasses for every stage's input/output contract.
- `modeling_agent.py` — deterministic POC implementation: scale resolution,
  curve classification, ground-profile derivation, speed/mass/downforce
  resolution. No LLM call yet; see inline notes for where one would plug in.
- `physics_agent.py` — the solver (ramp-phase energy conservation,
  per-point traction check, projectile flight phase, outcome
  classification), run via `code_executor.py`'s sandbox abstraction.
- `code_executor.py` — `LocalSubprocessExecutor` (default) and
  `DaytonaExecutor` (real sandbox, used automatically once credentials are
  present).
- `mock_extraction.py` — stand-in Extraction Agent output.
- `orchestrator.py` — sequences Modeling → Physics; `update_speed()` is the
  fast path that skips straight to Physics.
- `run_demo.py` — CLI entry point.

## Not yet implemented

- Extraction Agent (real sketch digitization + STT)
- SurrealDB memory read/write
- anchorbrowser lookup (currently a hardcoded `KNOWN_SPECS` dict in
  `modeling_agent.py` stands in for it)
- LLM-backed curve classification for ambiguous sketches (currently a
  vertical-extent heuristic); see `../docs/bedrock-integration.md` for the
  LLM backend to use once this is added.
- Agent-generated (vs. fixed-template) solver code for the Physics Agent —
  same documented shortcut as the Modeling Agent's heuristic classification.
