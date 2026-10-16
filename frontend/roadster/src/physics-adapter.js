import { normalizeTrajectory } from './trajectory.js';
import { validateRampCurve } from './curve-track.js';

const MAX_SAMPLES = 50_000;
const OUTCOMES = new Set(['cleared', 'fell_short', 'landed_normal', 'lost_traction']);
const GROUND_TYPES = new Set(['flat', 'gap', 'lower_level']);
const METRIC_NUMBERS = [
  'max_required_downforce_n', 'launch_angle_deg', 'launch_speed_ms',
  'hang_time_s', 'max_height_m', 'landing_x_m',
];
const WARNINGS = [
  'Vehicle orientation follows the velocity direction atan2(vy, vx). At zero velocity, the last valid heading is retained (initially +X). This is not a physically solved orientation and excludes flipping and rotational dynamics.',
  'Original center-of-mass/point-mass coordinates are preserved in position and the path line. The ramp surface follows the input curve. For display, the car center is raised by half its height along its local +Y axis; see displayPosition. This does not solve tire-surface or rigid-body contact.',
];

function fail(message) {
  throw new Error(`Invalid physics result: ${message}`);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be a finite number.`);
  return value;
}

function pointArray(value, name) {
  if (!Array.isArray(value) || value.length < 2) fail(`${name} requires at least 2 points.`);
  if (value.length > MAX_SAMPLES) fail(`${name} must not exceed ${MAX_SAMPLES} points.`);
  return value;
}

function validateProblemSpec(problemSpec) {
  object(problemSpec, 'problemSpec (the matching simulation input is required)');
  const ramp = pointArray(problemSpec.ramp_curve_m, 'problemSpec.ramp_curve_m');
  try { validateRampCurve(ramp); } catch(error) { fail(error.message); }
  for (const [index, point] of ramp.entries()) {
    const name = `problemSpec.ramp_curve_m[${index}]`;
    object(point, name);
    finite(point.x, `${name}.x`);
    finite(point.y, `${name}.y`);
  }
  for (const key of ['entry_speed_ms', 'car_mass_kg']) {
    if (finite(problemSpec[key], `problemSpec.${key}`) <= 0) fail(`problemSpec.${key} must be greater than 0.`);
  }
  if (finite(problemSpec.downforce_capability_n, 'problemSpec.downforce_capability_n') < 0) {
    fail('problemSpec.downforce_capability_n must not be negative.');
  }
  const ground = object(problemSpec.ground_profile, 'problemSpec.ground_profile');
  if (!GROUND_TYPES.has(ground.type)) fail('ground_profile.type must be flat, gap, or lower_level.');
  finite(ground.landing_level_m, 'ground_profile.landing_level_m');
  if (ground.type === 'gap') {
    finite(ground.gap_start_x_m, 'ground_profile.gap_start_x_m');
    finite(ground.gap_end_x_m, 'ground_profile.gap_end_x_m');
    if (ground.gap_end_x_m <= ground.gap_start_x_m) fail('gap_end_x_m must be greater than gap_start_x_m.');
  }
}

function validateMetrics(metrics) {
  object(metrics, 'metrics');
  if (typeof metrics.traction_ok !== 'boolean') fail('metrics.traction_ok must be a boolean.');
  if (!OUTCOMES.has(metrics.outcome)) fail('metrics.outcome must be cleared, fell_short, landed_normal, or lost_traction.');
  for (const key of METRIC_NUMBERS) finite(metrics[key], `metrics.${key}`);
  // The backend deliberately returns null for non-gap and lost-traction results.
  if (metrics.margin_m !== undefined && metrics.margin_m !== null) finite(metrics.margin_m, 'metrics.margin_m');
}

/**
 * Render a Physics Agent result together with the exact ProblemSpec used to solve it.
 * The caller owns that pairing: the output contract has no request identity or
 * geometry with which an adapter could independently verify it. No physics is
 * recomputed, and COM positions are never offset, resampled, or reoriented.
 */
export function adaptPhysicsResult(input) {
  object(input, 'Input');
  const { result, problemSpec } = input;
  object(result, 'result');
  // Surface backend errors before requiring successful-result geometry/metrics.
  if (result.status === 'error') {
    const code = typeof result.error?.code === 'string' ? result.error.code : 'unknown_error';
    const message = typeof result.error?.message === 'string' ? result.error.message : 'The backend did not provide error details.';
    throw new Error(`Physics Agent [${code}]: ${message}`);
  }
  if (result.status !== 'ok') fail('result.status must be ok or error.');
  if (result.error !== null && result.error !== undefined) fail('error must be empty when status is ok.');
  validateProblemSpec(problemSpec);
  validateMetrics(result.metrics);
  const execution = object(result.execution, 'execution');
  if (finite(execution.duration_ms, 'execution.duration_ms') < 0) fail('execution.duration_ms must not be negative.');
  if (typeof execution.sandbox_id !== 'string') fail('execution.sandbox_id must be a string.');

  const rawSamples = pointArray(result.trajectory, 'trajectory');
  let heading = 0;
  const samples = Array.from(rawSamples, (sample, index) => {
    const name = `trajectory[${index}]`;
    object(sample, name);
    for (const key of ['t', 'x', 'y', 'vx', 'vy']) finite(sample[key], `${name}.${key}`);
    if (sample.phase !== 'ramp' && sample.phase !== 'flight') fail(`${name}.phase must be ramp or flight.`);
    if (sample.vx !== 0 || sample.vy !== 0) heading = Math.atan2(sample.vy, sample.vx);
    return {
      t: sample.t,
      position: [sample.x, sample.y, 0],
      quaternion: [0, 0, Math.sin(heading / 2), Math.cos(heading / 2)],
    };
  });
  const trajectory = normalizeTrajectory({
    version: 1,
    units: 'm',
    upAxis: 'Y',
    label: `Physics Agent · ${result.metrics.outcome} · ${samples.length} points`,
    samples,
  });
  trajectory.source = 'physics';
  trajectory.warnings = [...WARNINGS];
  return {
    trajectory,
    problemSpec: structuredClone(problemSpec),
    metrics: structuredClone(result.metrics),
    execution: structuredClone(execution),
    phases: trajectory.samples.map((sample, index) => ({ t: sample.t, phase: rawSamples[index].phase })),
    warnings: [...WARNINGS],
  };
}
