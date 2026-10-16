import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOLVER_PATH = fileURLToPath(new URL('./vendor/physics_solver.py', import.meta.url));
const TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 20 * 1024 * 1024;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function invalid(message) {
  throw failure('invalid_input', message);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object.`);
}

function bounded(value, low, high, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
    invalid(`${name} must be a finite number in [${low}, ${high}].`);
  }
  return value;
}

function validateSpec(spec, index) {
  const name = `specs[${index}]`;
  object(spec, name);
  if (!Array.isArray(spec.ramp_curve_m) || spec.ramp_curve_m.length < 2 || spec.ramp_curve_m.length > 1000) {
    invalid(`${name}.ramp_curve_m must contain 2–1000 points.`);
  }
  const ramp = Array.from(spec.ramp_curve_m, (point, i) => {
    object(point, `${name}.ramp_curve_m[${i}]`);
    return {
      x: bounded(point.x, -1000, 1000, `${name}.ramp_curve_m[${i}].x`),
      y: bounded(point.y, -1000, 1000, `${name}.ramp_curve_m[${i}].y`),
    };
  });
  for (let i = 1; i < ramp.length; i += 1) {
    if (ramp[i].x === ramp[i - 1].x && ramp[i].y === ramp[i - 1].y) {
      invalid(`${name}.ramp_curve_m must not contain consecutive identical points.`);
    }
  }
  object(spec.ground_profile, `${name}.ground_profile`);
  if (spec.ground_profile.type !== 'flat') invalid(`${name}.ground_profile.type must be flat.`);
  // Construct the only data sent to Python; client-supplied code/paths/options
  // cannot enter the process arguments or the solver module.
  return {
    ramp_curve_m: ramp,
    entry_speed_ms: bounded(spec.entry_speed_ms, 1, 100, `${name}.entry_speed_ms`),
    car_mass_kg: bounded(spec.car_mass_kg, 100, 10_000, `${name}.car_mass_kg`),
    downforce_capability_n: bounded(spec.downforce_capability_n, 0, 10_000_000, `${name}.downforce_capability_n`),
    ground_profile: {
      type: 'flat',
      landing_level_m: bounded(spec.ground_profile.landing_level_m, -1000, 1000, `${name}.ground_profile.landing_level_m`),
    },
  };
}

function validateResults(results, expectedCount) {
  const fail = () => { throw failure('result_sanity_check_failed', 'Python solver returned an invalid or nonfinite result.'); };
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  if (!Array.isArray(results) || results.length !== expectedCount) fail();
  for (const result of results) {
    if (result?.status !== 'ok' || result.error !== null) fail();
    if (!Array.isArray(result.trajectory) || result.trajectory.length < 2 || result.trajectory.length > 50_000) fail();
    let previousTime = -Infinity;
    for (const point of result.trajectory) {
      if (!point || !['t', 'x', 'y', 'vx', 'vy'].every((key) => finite(point[key]))) fail();
      if (point.t <= previousTime || !['ramp', 'flight'].includes(point.phase)) fail();
      previousTime = point.t;
    }
    // Preserve the upstream agent's forward-landing sanity boundary.
    if (result.trajectory.at(-1).x < result.trajectory[0].x) fail();
    const metrics = result.metrics;
    if (!metrics || typeof metrics.traction_ok !== 'boolean' || !['landed_normal', 'lost_traction'].includes(metrics.outcome)) fail();
    for (const key of ['max_required_downforce_n', 'launch_angle_deg', 'launch_speed_ms', 'hang_time_s', 'max_height_m', 'landing_x_m']) {
      if (!finite(metrics[key])) fail();
    }
    if (metrics.margin_m !== null) fail();
    if (!finite(result.execution?.duration_ms) || result.execution.duration_ms < 0 ||
        typeof result.execution.sandbox_id !== 'string' || !result.execution.sandbox_id.startsWith('local-live-')) fail();
  }
  return results;
}

/** Run 1–128 validated specs in one trusted Python process; no upstream checkout is needed. */
export async function runPhysics(specs, { signal } = {}) {
  const deadline = performance.now() + TIMEOUT_MS;
  const timeoutError = () => failure('solver_timeout', 'Physics calculation exceeded the 15 second batch limit.');
  const abortError = () => Object.assign(failure('ABORT_ERR', 'Physics calculation was cancelled.'), { name: 'AbortError' });
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal must be an AbortSignal.');
  if (signal?.aborted) throw abortError();
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > 128) invalid('specs must contain 1–128 problem specifications.');
  const expectedCount = specs.length;
  const input = JSON.stringify(Array.from(specs, validateSpec));
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C' };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-I', SOLVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let stopError = null;
    let stdoutBytes = 0;
    const chunks = [];
    const stop = (error) => {
      if (settled || stopError) return;
      stopError = error;
      child.kill('SIGKILL');
    };
    const onAbort = () => stop(abortError());
    const timer = setTimeout(() => stop(timeoutError()), Math.max(0, deadline - performance.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(result);
    }
    child.on('error', (error) => finish(failure('solver_unavailable', error.code === 'ENOENT'
      ? `Python 3 is required; ${executable} was not found on PATH.`
      : 'The local Python solver could not start.')));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop(failure('solver_output_limit', 'Physics output exceeded the 20 MiB batch limit.'));
      } else if (!stopError) {
        chunks.push(chunk);
      }
    });
    // Drain diagnostics without retaining or returning environment/path details.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {}); // close/error below reports process failure, including EPIPE.
    child.on('close', (code) => {
      if (stopError) return finish(stopError);
      if (performance.now() > deadline) return finish(timeoutError());
      if (code !== 0) return finish(failure('solver_execution_failed', 'The local Python solver failed.'));
      let results;
      try {
        results = validateResults(JSON.parse(Buffer.concat(chunks).toString('utf8')), expectedCount);
      } catch (error) {
        return finish(error.code === 'result_sanity_check_failed' ? error
          : failure('result_sanity_check_failed', 'Python solver did not return valid JSON.'));
      }
      finish(performance.now() > deadline ? timeoutError() : null, results);
    });
    child.stdin.end(input);
  });
}
