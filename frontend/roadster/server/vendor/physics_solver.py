
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


def solve(spec):
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
    return result



def _batch_main():
    # Only the runner's validated JSON data enters this fixed solver module.
    import time
    import uuid

    specs = json.load(sys.stdin)
    batch_id = uuid.uuid4().hex
    results = []
    for index, spec in enumerate(specs):
        started = time.perf_counter()
        result = solve(spec)
        result["execution"] = {
            "duration_ms": (time.perf_counter() - started) * 1000,
            "sandbox_id": f"local-live-{batch_id}-{index}",
        }
        result["error"] = None
        results.append(result)
    print(json.dumps(results, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        _batch_main()
    except Exception:
        # Avoid returning tracebacks, paths, or environment details to clients.
        print("Physics solver failed.", file=sys.stderr)
        raise SystemExit(1)
