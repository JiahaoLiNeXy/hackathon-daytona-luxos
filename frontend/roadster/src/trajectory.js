import { Quaternion, Vector3 } from 'three';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SAMPLES = 50_000;
const POSITION_KEYS = ['x', 'y', 'z'];
const QUATERNION_KEYS = ['qx', 'qy', 'qz', 'qw'];
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const INFERRED_ORIENTATION_WARNING = 'Orientation omitted: heading and pitch follow the path tangent. Roll is not included, and actual vehicle orientation cannot be recovered.';

function fail(message) {
  throw new Error(`Invalid trajectory: ${message}`);
}

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${name} must be a finite number.`);
  }
  return value;
}

function numericArray(value, length, name) {
  if (!Array.isArray(value) || value.length !== length) {
    fail(`${name} must contain ${length} numbers.`);
  }
  return Array.from(value, (component, index) => finiteNumber(component, `${name}[${index}]`));
}

function normalizedQuaternion(value, name) {
  const components = numericArray(value, 4, name);
  // Scaling first avoids overflow and underflow for otherwise valid finite input.
  const scale = Math.max(...components.map(Math.abs));
  if (scale === 0) fail(`${name} must not be a zero quaternion.`);
  const scaled = components.map((component) => component / scale);
  const length = Math.hypot(...scaled);
  return scaled.map((component) => component / length);
}

function samePosition(a, b) {
  return a.every((component, axis) => component === b[axis]);
}

function directionBetween(a, b) {
  const scale = Math.max(...a.map(Math.abs), ...b.map(Math.abs), 1);
  return b.map((component, axis) => component / scale - a[axis] / scale);
}

function inferOrientations(samples) {
  // Nearest distinct neighbors keep pauses stable without quadratic scans.
  const before = new Int32Array(samples.length);
  const after = new Int32Array(samples.length);
  before[0] = -1;
  after[samples.length - 1] = -1;
  for (let i = 1; i < samples.length; i += 1) {
    before[i] = samePosition(samples[i].position, samples[i - 1].position) ? before[i - 1] : i - 1;
  }
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    after[i] = samePosition(samples[i].position, samples[i + 1].position) ? after[i + 1] : i + 1;
  }
  let lastYaw = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = before[i] < 0 ? i : before[i];
    const b = after[i] < 0 ? i : after[i];
    let direction = directionBetween(samples[a].position, samples[b].position);
    if (direction.every((component) => component === 0) && after[i] >= 0) {
      // At an exact reversal, use the outgoing segment instead of a zero tangent.
      direction = directionBetween(samples[i].position, samples[after[i]].position);
    }
    const [dx, dy, dz] = direction;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal > 0) lastYaw = -Math.atan2(dz, dx);
    const pitch = Math.atan2(dy, horizontal);
    samples[i].quaternion = new Quaternion()
      .setFromAxisAngle(Y_AXIS, lastYaw)
      .multiply(new Quaternion().setFromAxisAngle(Z_AXIS, pitch))
      .normalize()
      .toArray();
  }
}

/** Normalize imported metre/Y-up samples without moving their spatial origin. */
export function normalizeTrajectory(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('The top-level JSON value must be an object.');
  if (data.version !== undefined && data.version !== 1) fail('Only version: 1 is supported.');
  if (data.units !== undefined && data.units !== 'm') fail('units must be "m". Convert to meters first.');
  if (data.upAxis !== undefined && data.upAxis !== 'Y') fail('upAxis must be "Y". Convert the axes first.');
  if (!Array.isArray(data.samples) || data.samples.length < 2) fail('At least 2 samples are required.');
  if (data.samples.length > MAX_SAMPLES) fail(`No more than ${MAX_SAMPLES} samples are allowed.`);
  if (data.label !== undefined && typeof data.label !== 'string') fail('label must be a string.');

  let previousTime = -Infinity;
  let quaternionCount = 0;
  const samples = Array.from(data.samples, (sample, index) => {
    const name = `Sample ${index + 1}`;
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) fail(`${name} must be an object.`);
    const t = finiteNumber(sample.t, `${name}.t`);
    if (t <= previousTime) fail(`${name}.t must be strictly increasing.`);
    previousTime = t;
    const position = numericArray(
      sample.position === undefined ? POSITION_KEYS.map((key) => sample[key]) : sample.position,
      3,
      `${name}.position`,
    );
    const hasQuaternion = sample.quaternion !== undefined || QUATERNION_KEYS.some((key) => sample[key] !== undefined);
    let quaternion;
    if (hasQuaternion) {
      quaternionCount += 1;
      quaternion = normalizedQuaternion(
        sample.quaternion === undefined ? QUATERNION_KEYS.map((key) => sample[key]) : sample.quaternion,
        `${name}.quaternion`,
      );
    }
    return { t, position, quaternion };
  });
  if (quaternionCount !== 0 && quaternionCount !== samples.length) {
    fail('Provide complete orientation for every sample or omit it from every sample.');
  }

  const timeOffset = samples[0].t;
  previousTime = -Infinity;
  for (const sample of samples) {
    sample.t -= timeOffset;
    if (!Number.isFinite(sample.t) || sample.t <= previousTime) fail('Time span exceeds numeric precision.');
    previousTime = sample.t;
  }
  const warnings = [];
  if (quaternionCount === 0) {
    inferOrientations(samples);
    warnings.push(INFERRED_ORIENTATION_WARNING);
  }
  return {
    samples,
    duration: samples[samples.length - 1].t,
    timeOffset,
    label: data.label?.trim() || 'Imported path',
    warnings,
    source: 'imported',
  };
}

function csvCells(line, lineNumber) {
  return line.split(',').map((cell) => {
    const value = cell.trim();
    if (!value.includes('"')) return value;
    if (/^"[^"]*"$/.test(value)) return value.slice(1, -1).trim();
    fail(`CSV line ${lineNumber} uses unsupported quoting.`);
  });
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\n|\r/).map((line, index) => ({ line, lineNumber: index + 1 })).filter(({ line }) => line.trim());
  if (lines.length < 3) fail('CSV requires a header and at least 2 data rows.');
  if (lines.length - 1 > MAX_SAMPLES) fail(`No more than ${MAX_SAMPLES} samples are allowed.`);
  const headers = csvCells(lines[0].line, lines[0].lineNumber);
  const required = ['t', ...POSITION_KEYS];
  const allowed = [...required, ...QUATERNION_KEYS];
  if (new Set(headers).size !== headers.length || headers.some((header) => !allowed.includes(header))) {
    fail('CSV headers contain duplicate or unknown fields. Supported fields: t,x,y,z,qx,qy,qz,qw.');
  }
  if (required.some((header) => !headers.includes(header))) fail('CSV must include t,x,y,z headers.');
  const quaternionColumns = QUATERNION_KEYS.filter((key) => headers.includes(key)).length;
  if (quaternionColumns !== 0 && quaternionColumns !== 4) fail('CSV quaternion data requires all four qx,qy,qz,qw columns.');
  const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  return {
    samples: lines.slice(1).map(({ line, lineNumber }) => {
      const cells = csvCells(line, lineNumber);
      if (cells.length !== headers.length) fail(`CSV line ${lineNumber} has a different column count from the header.`);
      return Object.fromEntries(headers.map((header, column) => {
        const value = cells[column];
        if (!numberPattern.test(value)) fail(`CSV line ${lineNumber}, ${header} must be a number and cannot be blank.`);
        return [header, finiteNumber(Number(value), `CSV line ${lineNumber}, ${header}`)];
      }));
    }),
  };
}

/** Parse UTF-8 JSON or numeric CSV. Parsing never starts playback. */
export function parseTrajectory(text, filename = 'trajectory.json') {
  if (typeof text !== 'string') fail('File contents must be text.');
  if (text.length >= MAX_FILE_BYTES || new TextEncoder().encode(text).byteLength >= MAX_FILE_BYTES) {
    fail('File must be smaller than 10 MiB.');
  }
  const content = text.replace(/^\uFEFF/, '').trim();
  const extension = String(filename).split('.').pop().toLowerCase();
  if (!['json', 'csv'].includes(extension)) fail('Only .json or .csv files are supported.');
  let data;
  if (extension === 'csv') {
    data = parseCsv(content);
  } else {
    try {
      data = JSON.parse(content);
    } catch {
      fail('Invalid JSON syntax.');
    }
  }
  const trajectory = normalizeTrajectory(data);
  if (!data.label?.trim()) trajectory.label = String(filename).split(/[\\/]/).pop();
  return trajectory;
}

/** Position is linear; attitude uses normalized shortest-arc quaternion slerp. */
export function sampleTrajectory(trajectory, t) {
  finiteNumber(t, 'Playback time');
  const { samples } = trajectory;
  let low = 0;
  let high = samples.length - 1;
  if (t <= samples[low].t) high = low;
  else if (t >= samples[high].t) low = high;
  else {
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].t <= t) low = middle;
      else high = middle;
    }
  }
  const a = samples[low];
  const b = samples[high];
  const alpha = low === high ? 0 : (t - a.t) / (b.t - a.t);
  const position = new Vector3(...a.position.map((component, axis) => (1 - alpha) * component + alpha * b.position[axis]));
  const quaternion = new Quaternion().fromArray(a.quaternion)
    .slerp(new Quaternion().fromArray(b.quaternion), alpha).normalize();
  return { position, quaternion };
}
