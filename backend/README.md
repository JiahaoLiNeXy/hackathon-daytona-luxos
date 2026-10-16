# Backend (POC)

Minimal V0 orchestrator (see `../docs/orchestrator-spec.md`) wired to a real
Modeling Agent implementation (see `../docs/modeling-agent-spec.md`).

Extraction and Physics agents aren't built yet — `mock_extraction.py` stands
in for Extraction, and the orchestrator currently stops after Modeling.

## Run

```bash
cd backend
python3 run_demo.py
```

Prints the Modeling Agent's `problem_spec` + `sources` for two mocked
scenarios: a fully-specified loop (grid+legend, spoken speed/entity) and a
sparse sketch that exercises every `assumed_default` fallback.

## Files

- `schemas.py` — dataclasses matching the Extraction output / Modeling
  output (== Physics Agent input) contracts.
- `modeling_agent.py` — deterministic POC implementation: scale resolution,
  curve classification, ground-profile derivation, speed/mass/downforce
  resolution. No LLM call yet; see inline notes for where one would plug in.
- `mock_extraction.py` — stand-in Extraction Agent output.
- `orchestrator.py` — sequences Modeling (and, once built, Physics).
- `run_demo.py` — CLI entry point.

## Not yet implemented

- Extraction Agent (real sketch digitization + STT)
- Physics Agent (Daytona-sandboxed solver)
- SurrealDB memory read/write
- anchorbrowser lookup (currently a hardcoded `KNOWN_SPECS` dict in
  `modeling_agent.py` stands in for it)
- LLM-backed curve classification for ambiguous sketches (currently a
  vertical-extent heuristic); see `../docs/bedrock-integration.md` for the
  LLM backend to use once this is added.
