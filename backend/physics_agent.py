"""Physics Agent — see docs/physics-agent-spec.md.

For the POC, the "generate solver code" step produces a fixed template
rather than an LLM-authored script each time — same documented shortcut as
the Modeling Agent's heuristic-only curve classification. The behavior the
spec actually cares about (execute agent-owned code in an isolated sandbox,
not a hardcoded in-process function call) is real: the template below is
written to disk and run as its own OS process via the `CodeExecutor`
abstraction, which swaps to a real Daytona sandbox once that's wired in.
"""
from __future__ import annotations

import math

from code_executor import CodeExecutionError, CodeExecutor, LocalSubprocessExecutor
from schemas import (
    PhysicsError,
    PhysicsExecution,
    PhysicsMetrics,
    PhysicsResult,
    ProblemSpec,
    TrajectoryPoint,
)

# Reads a JSON problem spec from stdin, prints exactly one JSON result to
# stdout. Implements spec responsibilities 2-6: ramp-phase energy
# conservation, per-point traction check, launch conditions, projectile
# flight phase, outcome classification.
SOLVER_CODE = r"""
import json
import math
import sys


def circum_radius(a, b, c):
    ab = math.hypot(b[0] - a[0], b[1] - a[1])
    bc = math.hypot(c[0] - b[0], c[1] - b[1])
    ca = math.hypot(a[0] - c[0], a[1] - c[1])
    area2 = abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]))
    if area2 < 1e-9:
        return float("inf")  # collinear -> effectively straight, no centripetal force needed
    return (ab * bc * ca) / (2 * area2)


def tangent_angle(p_from, p_to):
    return math.atan2(p_to[1] - p_from[1], p_to[0] - p_from[0])


def main():
    spec = json.load(sys.stdin)
    g = 9.81
    ramp = [(p["x"], p["y"]) for p in spec["ramp_curve_m"]]
    v0 = spec["entry_speed_ms"]
    mass = spec["car_mass_kg"]
    downforce_cap = spec["downforce_capability_n"]
    ground = spec["ground_profile"]

    base_y = ramp[0][1]
    trajectory = []
    speeds = [v0]
    t = 0.0
    trajectory.append({"t": 0.0, "x": ramp[0][0], "y": ramp[0][1], "vx": v0, "vy": 0.0, "phase": "ramp"})

    traction_ok = True
    max_required_downforce = 0.0
    launch_index = len(ramp) - 1  # default: reach the ramp's actual exit

    for i in range(1, len(ramp)):
        v_sq = v0 ** 2 - 2 * g * (ramp[i][1] - base_y)
        if v_sq <= 0:
            # Not enough entry speed to climb this high -> stalls out here.
            traction_ok = False
            launch_index = i - 1
            break
        v_i = math.sqrt(v_sq)
        speeds.append(v_i)

        if 0 < i < len(ramp) - 1:
            r = circum_radius(ramp[i - 1], ramp[i], ramp[i + 1])
        else:
            r = float("inf")
        if r != float("inf"):
            required = mass * (v_i ** 2) / r
            available = mass * g + downforce_cap  # POC simplification, see spec non-goals
            max_required_downforce = max(max_required_downforce, required)
            if required > available:
                traction_ok = False
                launch_index = i
                break

        seg_len = math.hypot(ramp[i][0] - ramp[i - 1][0], ramp[i][1] - ramp[i - 1][1])
        avg_v = (speeds[i - 1] + v_i) / 2
        dt = seg_len / avg_v if avg_v > 0 else 0.0
        t += dt
        angle = tangent_angle(ramp[i - 1], ramp[i])
        trajectory.append({
            "t": t, "x": ramp[i][0], "y": ramp[i][1],
            "vx": v_i * math.cos(angle), "vy": v_i * math.sin(angle), "phase": "ramp",
        })

    launch_point = ramp[launch_index]
    launch_speed = speeds[launch_index] if launch_index < len(speeds) else speeds[-1]
    if launch_index == 0:
        launch_angle = tangent_angle(ramp[0], ramp[1]) if len(ramp) > 1 else 0.0
    else:
        launch_angle = tangent_angle(ramp[launch_index - 1], ramp[launch_index])

    vx0 = launch_speed * math.cos(launch_angle)
    vy0 = launch_speed * math.sin(launch_angle)

    landing_level = ground.get("landing_level_m", 0.0)
    dt_flight = 0.02
    t_flight = 0.0
    x, y = launch_point
    max_height = max(p["y"] for p in trajectory)
    flight_points = []
    while True:
        t_flight += dt_flight
        x = launch_point[0] + vx0 * t_flight
        y = launch_point[1] + vy0 * t_flight - 0.5 * g * t_flight ** 2
        vy = vy0 - g * t_flight
        max_height = max(max_height, y)
        flight_points.append({
            "t": trajectory[-1]["t"] + t_flight, "x": x, "y": y,
            "vx": vx0, "vy": vy, "phase": "flight",
        })
        if y <= landing_level or t_flight > 60:
            break

    trajectory.extend(flight_points)
    hang_time = t_flight
    landing_x = x

    if not traction_ok:
        outcome = "lost_traction"
        margin = None
    elif ground["type"] == "gap":
        gap_end = ground["gap_end_x_m"]
        if landing_x >= gap_end:
            outcome = "cleared"
            margin = landing_x - gap_end
        else:
            outcome = "fell_short"
            margin = landing_x - gap_end
    else:
        outcome = "landed_normal"
        margin = None

    result = {
        "status": "ok",
        "trajectory": trajectory,
        "metrics": {
            "traction_ok": traction_ok,
            "max_required_downforce_n": max_required_downforce,
            "launch_angle_deg": math.degrees(launch_angle),
            "launch_speed_ms": launch_speed,
            "hang_time_s": hang_time,
            "max_height_m": max_height,
            "landing_x_m": landing_x,
            "outcome": outcome,
            "margin_m": margin,
        },
    }
    print(json.dumps(result))


main()
"""


class PhysicsAgent:
    def __init__(self, executor: CodeExecutor | None = None):
        self.executor = executor or LocalSubprocessExecutor()

    def run(self, problem_spec: ProblemSpec) -> PhysicsResult:
        validation_error = self._validate(problem_spec)
        if validation_error:
            return PhysicsResult(status="error", error=validation_error)

        input_data = problem_spec.to_dict()
        try:
            outcome = self.executor.run(SOLVER_CODE, input_data, timeout_s=5.0)
        except CodeExecutionError as exc:
            return PhysicsResult(
                status="error",
                error=PhysicsError(code="sandbox_execution_failed", message=str(exc)),
            )

        sanity_error = self._sanity_check(outcome.result)
        if sanity_error:
            return PhysicsResult(status="error", error=sanity_error)

        trajectory = [TrajectoryPoint(**p) for p in outcome.result["trajectory"]]
        metrics = PhysicsMetrics(**outcome.result["metrics"])
        return PhysicsResult(
            status="ok",
            trajectory=trajectory,
            metrics=metrics,
            execution=PhysicsExecution(
                duration_ms=outcome.duration_ms, sandbox_id=outcome.sandbox_id
            ),
        )

    @staticmethod
    def _validate(spec: ProblemSpec) -> PhysicsError | None:
        if len(spec.ramp_curve_m) < 2:
            return PhysicsError(code="invalid_input", message="ramp_curve_m needs >= 2 points")
        if spec.entry_speed_ms <= 0:
            return PhysicsError(code="invalid_input", message="entry_speed_ms must be > 0")
        if spec.car_mass_kg <= 0:
            return PhysicsError(code="invalid_input", message="car_mass_kg must be > 0")
        return None

    @staticmethod
    def _sanity_check(result: dict) -> PhysicsError | None:
        trajectory = result.get("trajectory", [])
        if not trajectory:
            return PhysicsError(code="result_sanity_check_failed", message="empty trajectory")
        times = [p["t"] for p in trajectory]
        if any(t2 < t1 for t1, t2 in zip(times, times[1:])):
            return PhysicsError(code="result_sanity_check_failed", message="non-monotonic time")
        if trajectory[-1]["x"] < trajectory[0]["x"]:
            return PhysicsError(
                code="result_sanity_check_failed", message="landing x precedes launch x"
            )
        for p in trajectory:
            if any(math.isnan(p[k]) for k in ("x", "y", "vx", "vy")):
                return PhysicsError(code="result_sanity_check_failed", message="NaN in trajectory")
        return None
