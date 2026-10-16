"""Real-world car spec lookup via Anchor Browser, run inside a Daytona
sandbox (per https://docs.anchorbrowser.io/integrations/sandboxes/daytona),
used by the Modeling Agent when an entity isn't in the local `KNOWN_SPECS`
cache or session memory.

Scoped deliberately narrow: this only looks up `mass_kg`. Curb weight is a
real, publicly documented spec worth fetching live. `downforce_capability_n`
is not a standard published spec for road cars — pretending to "look it up"
would just be fabrication with extra steps, so that field stays sourced
from `KNOWN_SPECS` or an assumed default regardless.

Uses the HTTP API directly (stdlib `urllib`, no `anchorbrowser` SDK
install needed in the sandbox) against the documented
`POST /v1/tools/perform-web-task` endpoint, auth header `anchor-api-key`,
env var `ANCHORBROWSER_API_KEY`.
"""
from __future__ import annotations

import os
from typing import Optional

from code_executor import CodeExecutionError, CodeExecutor, default_executor

LOOKUP_CODE = r"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    payload = json.load(sys.stdin)
    entity = payload["entity"]
    api_key = os.environ.get("ANCHORBROWSER_API_KEY")
    if not api_key:
        print(json.dumps({"status": "error", "message": "ANCHORBROWSER_API_KEY not set"}))
        return

    query = urllib.parse.quote(f"{entity} curb weight kg")
    body = {
        "url": f"https://www.google.com/search?q={query}",
        "prompt": (
            f"Find the curb weight (mass) of the {entity} in kilograms, from a "
            "reliable source (manufacturer site, Wikipedia, or a reputable "
            "automotive publication). Return only the requested structured output."
        ),
        "output_schema": {
            "type": "object",
            "properties": {
                "mass_kg": {"type": ["number", "null"]},
                "source_url": {"type": ["string", "null"]},
            },
            "required": ["mass_kg"],
        },
        "max_steps": 40,
        "llm_timeout": 60,
    }
    req = urllib.request.Request(
        "https://api.anchorbrowser.io/v1/tools/perform-web-task",
        data=json.dumps(body).encode(),
        headers={"anchor-api-key": api_key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=85) as resp:
            parsed = json.loads(resp.read())
    except urllib.error.URLError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))
        return
    except Exception as exc:
        print(json.dumps({"status": "error", "message": f"unexpected error: {exc}"}))
        return

    # `data.result` comes back as a JSON-encoded string, not a nested
    # object -- confirmed against the live API (not documented explicitly).
    raw_result = (parsed.get("data") or {}).get("result")
    if isinstance(raw_result, str):
        try:
            result = json.loads(raw_result)
        except json.JSONDecodeError:
            result = {}
    elif isinstance(raw_result, dict):
        result = raw_result
    else:
        result = {}

    print(json.dumps({
        "status": "ok",
        "mass_kg": result.get("mass_kg"),
        "source_url": result.get("source_url"),
    }))


main()
"""


class CarSpecLookup:
    def __init__(self, executor: Optional[CodeExecutor] = None):
        self.executor = executor or default_executor()

    def lookup_mass_kg(self, entity: str, timeout_s: float = 90.0) -> tuple[Optional[float], Optional[str]]:
        """Returns (mass_kg, source_url), or (None, None) if unavailable/not
        configured/failed. Never raises — a flaky lookup must never break
        the pipeline; the Modeling Agent falls back to an assumed default.
        """
        api_key = os.getenv("ANCHORBROWSER_API_KEY")
        if not api_key:
            return None, None

        try:
            outcome = self.executor.run(
                LOOKUP_CODE,
                {"entity": entity},
                timeout_s=timeout_s,
                env_vars={"ANCHORBROWSER_API_KEY": api_key},
            )
        except CodeExecutionError:
            return None, None

        result = outcome.result
        if result.get("status") != "ok":
            return None, None
        mass_kg = result.get("mass_kg")
        if not mass_kg:
            return None, None
        return mass_kg, result.get("source_url")
