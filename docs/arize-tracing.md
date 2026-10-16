# Agent-flow demo with Arize AX

The backend emits OpenTelemetry spans using OpenInference conventions. Each
capture is one trace with nested stages and tool calls. Physics continues to
use the predefined ramp/projectile solver; tracing does not add LLM calls.

## Connect Arize

1. In Arize AX, open **Settings → API keys** and obtain an API key and Space ID.
2. Install the backend dependencies:

   ```bash
   cd backend
   uv pip install --python .venv/bin/python -r requirements.txt
   ```

3. Add these entries to your existing `backend/.env` (gitignored):

   ```dotenv
   ARIZE_API_KEY=your-key
   ARIZE_SPACE_ID=your-space-id
   ARIZE_PROJECT_NAME=paper-to-screen
   PAPER_TRACE_BACKEND=arize
   ```

4. Run the demo:

   ```bash
   .venv/bin/python run_demo.py
   ```

   If Daytona is configured, the trace includes a real Daytona execution.
   To exercise the solver locally while still sending traces to Arize:

   ```bash
   .venv/bin/python run_demo.py --local
   ```

5. In Arize AX, open the `paper-to-screen` project and its traces. The demo
   creates three root traces: two captures and one speed update. Capture JSON
   includes a `trace_id` to match the exact request. The roots share a
   `session.id`, so you can associate the speed update with the captures.

The CLI loads `.env` before creating the orchestrator and flushes pending spans
on exit. A future API server must load configuration before constructing
`Orchestrator`; configuration runs once per process. Long-running services can
call `flush_traces()` during shutdown.

## What the trace shows

```text
Process capture [CHAIN]
├── Extraction (precomputed input) [AGENT]
├── Modeling Agent [AGENT]
│   ├── Resolve scale [CHAIN]
│   ├── Classify ramp and ground [CHAIN]
│   ├── Build ground profile [CHAIN]
│   └── Resolve vehicle specs [CHAIN]
│       └── Anchor Browser car mass lookup [TOOL, only on a cache/memory miss]
│           └── Daytona sandbox execution [TOOL, only when lookup is configured]
└── Physics Agent [AGENT]
    ├── Validate physics input [CHAIN]
    ├── Daytona sandbox execution [TOOL]
    └── Check solver result [CHAIN]

Update speed [CHAIN]
└── Physics Agent [AGENT]
    ├── Validate physics input [CHAIN]
    ├── Daytona sandbox execution [TOOL]
    └── Check solver result [CHAIN]
```

Without Daytona credentials (or with `--local`), execution spans are labeled
`Local subprocess execution`. Extraction is explicitly marked as precomputed;
no camera or speech processing is performed. Modeling is deterministic and
Physics uses a fixed template, recorded in span attributes.

The supplied mocks use cached/default vehicle specs, so they do not call Anchor
Browser. A scenario mentioning an uncached vehicle triggers its lookup; set
`ANCHORBROWSER_API_KEY` to enable the external request. If unconfigured, the
lookup span returns null values and no executor span is created beneath it.

Expand spans to inspect inputs, modeling sources/assumptions, solver code,
metrics, sandbox ID, and duration. Trajectories are summarized as point count
plus first/last points to avoid duplicating hundreds of samples in every span.
Full trajectories still reach the caller. API keys and executor environment
variables are excluded from selected trace inputs. Inputs and outputs contain
the scenario and transcript, so use demo content when exporting traces.

Returned stage errors mark their parent/root spans as errors. A valid physics
outcome such as `lost_traction` remains successful. Setup/export failures do not
replace pipeline results, and exports are batched for Arize.

## Verify without Arize credentials

Print OpenInference spans to stderr, with normal demo JSON on stdout:

```bash
cd backend
PAPER_TRACE_BACKEND=console .venv/bin/python run_demo.py --local
```

Disable tracing explicitly with `PAPER_TRACE_BACKEND=off`. With no tracing
configuration or Arize credentials, tracing defaults to off.

Run integration tests (in-memory exporter; no external services):

```bash
backend/.venv/bin/python -m unittest discover -s backend/tests -v
```

This integration provides the Arize trace view. A live stage-card panel inside
the product UI would be a separate frontend feature.

References: [Arize manual instrumentation](https://arize.com/docs/ax/observe/tracing/how-to-tracing-manual),
[Arize OpenTelemetry SDK](https://github.com/Arize-ai/arize-otel-python),
[OpenInference trace conventions](https://github.com/Arize-ai/openinference/blob/main/spec/traces.md).
