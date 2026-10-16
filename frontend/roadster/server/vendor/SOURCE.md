# Vendored Physics Agent solver

Source repository: https://github.com/incandescentxxc/hackathon-daytona-luxos

- Source revision: `b9d4ad4d98d276444978c1a703bb9692df39ed44` (working tree clean when copied).
- Source file: `backend/physics_agent.py`, string constant `SOLVER_CODE`.
- Upstream source file SHA-256: `5e33e8a9fed518e1bc8b95e28b19e9a8dfbce5f354207b0bead4fe14fd53d62f`.
- Original `SOLVER_CODE` UTF-8 SHA-256: `0c2a4f2b155afefdaf33c60c86a84d5cd3c7dcd2e4a44ed279beb696ac56ac2a` (4496 bytes).
- Vendored `physics_solver.py` SHA-256: `34cb7620bc9cee5f6be406782f488472690bb761ded1a3c642000687d043d086`.

No tracked LICENSE, COPYING, or NOTICE file and no explicit license declaration
were found in the upstream checkout. This records provenance; it does not grant
or assert redistribution rights. No license has been added or invented.

## Deliberate changes

The ramp/projectile mathematics is unchanged. The diff below is the entire change
from the original string: `main()` becomes `solve(spec)`, its input/output moves
to a batch wrapper, and each result receives real local timing plus an execution
identifier. There is no dynamic code execution, client-provided Python, `eval`,
or client-selected executable/path. The Node runner invokes this fixed file.
The preserved `max_required_downforce_n` name and constant-gravity approximation
are upstream behavior; this wrapper does not correct their physical meaning.

The wrapper's `duration_ms` measures each solve call, excluding interpreter
startup and JSON serialization. The shared UUID in `local-live-<batch>-<index>`
identifies the actual local process batch. This is not a Daytona sandbox or an
OS security sandbox.

## Runtime and boundary

Requires Node.js 18+ and Python 3.9+ on PATH (`python3`, or `python` on Windows).
Only Python standard-library modules are used; no pip install, upstream checkout,
Daytona API key, tracing SDK, or network call is needed. Ship this file and
`server/physics-runner.mjs` together. Python is started with `-I`; only PATH,
LANG, and Windows SystemRoot when relevant are inherited.

`runPhysics(specs, {signal})` accepts 1–128 specs, each with 2–1000 distinct
consecutive ramp points, finite coordinates/landing level within ±1000 m,
entry speed 1–100 m/s, mass 100–10000 kg, downforce 0–10000000 N, and flat ground.
It validates and snapshots all inputs before execution and keeps upstream forward
landing sanity checking. The complete batch has a 15 second deadline and a
20 MiB stdout budget; a large valid batch can hit the output budget and must be
split by its caller. Abort kills the owned child process. No error substitutes
fixture output or a fallback trajectory.

Run the built-in Node test runner (real-solver cases also require Python):

```sh
node --test tests/physics-runner.test.js
```

## Complete source diff

```diff
--- upstream SOLVER_CODE
+++ physics_solver.py
@@ -18,8 +18,7 @@
     return math.atan2(p_to[1] - p_from[1], p_to[0] - p_from[0])
 
 
-def main():
-    spec = json.load(sys.stdin)
+def solve(spec):
     g = 9.81
     ramp = [(p["x"], p["y"]) for p in spec["ramp_curve_m"]]
     v0 = spec["entry_speed_ms"]
@@ -133,7 +132,34 @@
             "margin_m": margin,
         },
     }
-    print(json.dumps(result))
+    return result
 
 
-main()
+
+def _batch_main():
+    # Only the runner's validated JSON data enters this fixed solver module.
+    import time
+    import uuid
+
+    specs = json.load(sys.stdin)
+    batch_id = uuid.uuid4().hex
+    results = []
+    for index, spec in enumerate(specs):
+        started = time.perf_counter()
+        result = solve(spec)
+        result["execution"] = {
+            "duration_ms": (time.perf_counter() - started) * 1000,
+            "sandbox_id": f"local-live-{batch_id}-{index}",
+        }
+        result["error"] = None
+        results.append(result)
+    print(json.dumps(results, allow_nan=False, separators=(",", ":")))
+
+
+if __name__ == "__main__":
+    try:
+        _batch_main()
+    except Exception:
+        # Avoid returning tracebacks, paths, or environment details to clients.
+        print("Physics solver failed.", file=sys.stderr)
+        raise SystemExit(1)
```
