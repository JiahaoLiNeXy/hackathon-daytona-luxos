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
  '车辆朝向仅按速度方向 atan2(vy, vx) 可视化；零速度沿用上一有效朝向（初始为 +X）。这不是物理求解的姿态，不包含翻转或旋转动力学。',
  '原始质心/质点坐标保留在 position 和轨迹线中。跑道路面按输入曲线生成，车模中心沿自身 +Y 抬起半车高作为渲染补偿，另见 displayPosition；这不是轮胎接触面或刚体接触求解。',
];

function fail(message) {
  throw new Error(`物理结果格式错误：${message}`);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} 必须是对象。`);
  return value;
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} 必须是有限数字。`);
  return value;
}

function pointArray(value, name) {
  if (!Array.isArray(value) || value.length < 2) fail(`${name} 至少需要 2 个点。`);
  if (value.length > MAX_SAMPLES) fail(`${name} 不能超过 ${MAX_SAMPLES} 个点。`);
  return value;
}

function validateProblemSpec(problemSpec) {
  object(problemSpec, 'problemSpec（必须提供此次求解对应的输入）');
  const ramp = pointArray(problemSpec.ramp_curve_m, 'problemSpec.ramp_curve_m');
  try { validateRampCurve(ramp); } catch(error) { fail(error.message); }
  for (const [index, point] of ramp.entries()) {
    const name = `problemSpec.ramp_curve_m[${index}]`;
    object(point, name);
    finite(point.x, `${name}.x`);
    finite(point.y, `${name}.y`);
  }
  for (const key of ['entry_speed_ms', 'car_mass_kg']) {
    if (finite(problemSpec[key], `problemSpec.${key}`) <= 0) fail(`problemSpec.${key} 必须大于 0。`);
  }
  if (finite(problemSpec.downforce_capability_n, 'problemSpec.downforce_capability_n') < 0) {
    fail('problemSpec.downforce_capability_n 不能小于 0。');
  }
  const ground = object(problemSpec.ground_profile, 'problemSpec.ground_profile');
  if (!GROUND_TYPES.has(ground.type)) fail('ground_profile.type 必须是 flat、gap 或 lower_level。');
  finite(ground.landing_level_m, 'ground_profile.landing_level_m');
  if (ground.type === 'gap') {
    finite(ground.gap_start_x_m, 'ground_profile.gap_start_x_m');
    finite(ground.gap_end_x_m, 'ground_profile.gap_end_x_m');
    if (ground.gap_end_x_m <= ground.gap_start_x_m) fail('gap_end_x_m 必须大于 gap_start_x_m。');
  }
}

function validateMetrics(metrics) {
  object(metrics, 'metrics');
  if (typeof metrics.traction_ok !== 'boolean') fail('metrics.traction_ok 必须是布尔值。');
  if (!OUTCOMES.has(metrics.outcome)) fail('metrics.outcome 必须是 cleared、fell_short、landed_normal 或 lost_traction。');
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
  object(input, '输入');
  const { result, problemSpec } = input;
  object(result, 'result');
  // Surface backend errors before requiring successful-result geometry/metrics.
  if (result.status === 'error') {
    const code = typeof result.error?.code === 'string' ? result.error.code : 'unknown_error';
    const message = typeof result.error?.message === 'string' ? result.error.message : '后端未提供错误详情。';
    throw new Error(`Physics Agent [${code}]: ${message}`);
  }
  if (result.status !== 'ok') fail('result.status 必须是 ok 或 error。');
  if (result.error !== null && result.error !== undefined) fail('status 为 ok 时 error 必须为空。');
  validateProblemSpec(problemSpec);
  validateMetrics(result.metrics);
  const execution = object(result.execution, 'execution');
  if (finite(execution.duration_ms, 'execution.duration_ms') < 0) fail('execution.duration_ms 不能小于 0。');
  if (typeof execution.sandbox_id !== 'string') fail('execution.sandbox_id 必须是字符串。');

  const rawSamples = pointArray(result.trajectory, 'trajectory');
  let heading = 0;
  const samples = Array.from(rawSamples, (sample, index) => {
    const name = `trajectory[${index}]`;
    object(sample, name);
    for (const key of ['t', 'x', 'y', 'vx', 'vy']) finite(sample[key], `${name}.${key}`);
    if (sample.phase !== 'ramp' && sample.phase !== 'flight') fail(`${name}.phase 必须是 ramp 或 flight。`);
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
    label: `Physics Agent · ${result.metrics.outcome} · ${samples.length} 点`,
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
