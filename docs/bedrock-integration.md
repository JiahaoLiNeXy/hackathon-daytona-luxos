# Bedrock integration handoff

Use the OpenAI Python SDK against Amazon Bedrock's OpenAI-compatible API.
The user confirmed that the `responses.create` example below worked in their
terminal with their existing `OPENAI_API_KEY` and `OPENAI_BASE_URL`.
This was a text-only smoke test; it has not been run from the demo backend.

## Working configuration

- AWS Region: `us-east-1` (N. Virginia).
- Model: `openai.gpt-oss-120b`.
- API: Responses (`client.responses.create`).
- Authentication: Bedrock API key passed through `OPENAI_API_KEY`.
- Endpoint: preserve the user's working `OPENAI_BASE_URL`. Its exact value
  was not shared in this session. AWS documents
  `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1` for this Region.

Set both environment variables in the process running the backend. Shell
exports in another terminal are not automatically available to an existing
backend or coding-agent session. The key belongs on the server, outside
source control and browser code. `OpenAI()` reads these variables directly;
it does not automatically load a `.env` file.

Agent Toolkit, MCP, and `aws login` are not required for this API-key path.

## Smoke test

With both variables already set, run:

```bash
uv run --with openai python - <<'PY'
from openai import OpenAI

client = OpenAI()
response = client.responses.create(
    model="openai.gpt-oss-120b",
    input=[
        {"role": "user", "content": "Write a one-sentence bedtime story about a unicorn."}
    ],
)
print(response.output_text)
PY
```

Expected result: a generated sentence. Add `openai` to the backend's declared
dependencies when implementing the integration; `uv run --with` is only the
standalone smoke-test command.

## Demo implementation notes

Reuse a server-side client for text calls in the modeling, physics-code
generation, and optional narration stages. Keep stage prompts separate and
validate generated JSON or code before passing it to the next stage. Physics
code execution belongs in the Daytona sandbox described in the project plan.

The smoke test does not establish support for sketch/photo input, tools,
structured-output options, or streaming. Verify those separately before
depending on them in the extraction stage. The pipeline can remain a fixed
sequence of calls without Agent Toolkit.

## Troubleshooting

- Missing configuration: check that both variables are set in the backend's
  environment without printing their values.
- Authentication failure: confirm the complete Bedrock key was loaded without
  quotes, whitespace, or a `Bearer ` prefix in the variable, and check its
  Region and expiration. Short-term keys expire with the source session,
  up to 12 hours.
- Earlier attempts: workshop browser `aws login` returned HTTP 400, and a
  Nova Micro Converse request returned HTTP 403 with an invalid-key message.
  Their causes were not confirmed. The later Responses smoke test succeeded;
  preserve that working configuration when wiring the backend.

References: [AWS Bedrock quickstart](https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html),
[Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).
