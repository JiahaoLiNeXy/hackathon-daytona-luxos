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
    """Intended production backend. Not implemented yet — needs Daytona
    credentials (e.g. DAYTONA_API_KEY) and the Daytona SDK/CLI. Raise
    rather than silently falling back, so a missing integration is loud.
    """

    def run(self, code: str, input_data: dict, timeout_s: float = 5.0) -> ExecutionOutcome:
        raise NotImplementedError(
            "DaytonaExecutor is not implemented yet — use LocalSubprocessExecutor "
            "for now, or wire in the Daytona SDK here."
        )
