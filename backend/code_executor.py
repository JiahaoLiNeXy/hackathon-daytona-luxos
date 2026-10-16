"""Sandboxed code execution abstraction for the Physics Agent.

`LocalSubprocessExecutor` is the POC stand-in: it runs generated code as a
real OS subprocess (isolated from the backend's own process, with a
timeout) so the Physics Agent's "write code, then execute it" behavior
works end to end without Daytona credentials.

`DaytonaExecutor` is the intended production backend per
docs/physics-agent-spec.md — swap it in once Daytona access is available.
Same interface, so nothing above this layer needs to change.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


class CodeExecutionError(Exception):
    pass


@dataclass
class ExecutionOutcome:
    result: dict
    duration_ms: float
    sandbox_id: str


class CodeExecutor:
    def run(self, code: str, input_data: dict, timeout_s: float = 5.0) -> ExecutionOutcome:
        raise NotImplementedError


class LocalSubprocessExecutor(CodeExecutor):
    """Runs `code` as a standalone script in a subprocess. The script must
    read a JSON object from stdin and print exactly one JSON object to
    stdout. Not a real sandbox (no filesystem/network isolation) — just
    process isolation + a timeout. Good enough for local POC testing.
    """

    def run(self, code: str, input_data: dict, timeout_s: float = 5.0) -> ExecutionOutcome:
        sandbox_id = f"local-{uuid.uuid4().hex[:8]}"
        start = time.perf_counter()
        with tempfile.TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "solver.py"
            script_path.write_text(code)
            try:
                proc = subprocess.run(
                    [sys.executable, str(script_path)],
                    input=json.dumps(input_data),
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                )
            except subprocess.TimeoutExpired as exc:
                raise CodeExecutionError(f"execution timed out after {timeout_s}s") from exc

        duration_ms = (time.perf_counter() - start) * 1000

        if proc.returncode != 0:
            raise CodeExecutionError(
                f"solver exited with code {proc.returncode}: {proc.stderr.strip()}"
            )
        try:
            result = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise CodeExecutionError(f"solver did not return valid JSON: {exc}") from exc

        return ExecutionOutcome(result=result, duration_ms=duration_ms, sandbox_id=sandbox_id)


class DaytonaExecutor(CodeExecutor):
    """Real Daytona sandbox backend. Requires `DAYTONA_API_KEY` (and
    optionally `DAYTONA_API_URL` / `DAYTONA_TARGET`) in the environment —
    the `daytona` SDK reads these itself; nothing is passed explicitly here
    so a key is never handled/logged by our own code.

    `SOLVER_CODE` (see physics_agent.py) reads its input via
    `json.load(sys.stdin)`. The SDK's `code_run` has no stdin parameter, so
    we prepend a small stub that monkey-patches `sys.stdin` with the input
    JSON before the solver code runs — the solver script itself is
    identical between executors.
    """

    def __init__(self):
        from daytona import Daytona  # imported lazily so it's only required if used

        self._daytona = Daytona()

    def run(self, code: str, input_data: dict, timeout_s: float = 5.0) -> ExecutionOutcome:
        import json as _json

        wrapped_code = (
            "import sys, io\n"
            f"sys.stdin = io.StringIO({_json.dumps(_json.dumps(input_data))})\n"
            + code
        )

        sandbox = self._daytona.create()
        sandbox_id = sandbox.id
        start = time.perf_counter()
        try:
            response = sandbox.process.code_run(wrapped_code, timeout=int(timeout_s))
        except Exception as exc:  # SDK raises its own DaytonaError subclasses
            raise CodeExecutionError(f"Daytona execution failed: {exc}") from exc
        finally:
            try:
                sandbox.delete()
            except Exception:
                pass  # best-effort cleanup; don't mask the real result/error

        duration_ms = (time.perf_counter() - start) * 1000

        if response.exit_code != 0:
            raise CodeExecutionError(
                f"solver exited with code {response.exit_code}: {response.result}"
            )
        try:
            result = _json.loads(response.artifacts.stdout)
        except _json.JSONDecodeError as exc:
            raise CodeExecutionError(f"solver did not return valid JSON: {exc}") from exc

        return ExecutionOutcome(result=result, duration_ms=duration_ms, sandbox_id=sandbox_id)


def default_executor() -> CodeExecutor:
    """Daytona if credentials are present, otherwise the local subprocess
    stub — same fallback pattern used for the anchorbrowser/LLM extension
    points elsewhere in the pipeline."""
    if os.getenv("DAYTONA_API_KEY"):
        return DaytonaExecutor()
    return LocalSubprocessExecutor()
