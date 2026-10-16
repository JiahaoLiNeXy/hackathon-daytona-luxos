import * as THREE from 'three';

const DEFAULTS = { width: 5.6, thickness: 0.28 };
const MAX_POINTS = 50_000;
const MAX_FRAME_STATIONS = 13;

const invalid = (message) => { throw new Error(`跑道曲线格式错误：${message}`); };

/** Validate the source polyline and return an independent, unshifted copy in metres. */
export function validateRampCurve(rampCurve) {
  if (!Array.isArray(rampCurve) || rampCurve.length < 2 || rampCurve.length > MAX_POINTS) {
    invalid('ramp_curve_m 必须包含 2 至 50000 个点');
  }
  const copy = [];
  for (let i = 0; i < rampCurve.length; i++) {
    const point = rampCurve[i];
    if (!point || typeof point !== 'object' || Array.isArray(point)
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      invalid(`ramp_curve_m[${i}] 的 x、y 必须是有限数字`);
    }
    if (![point.x, point.y].every((value) => Number.isFinite(Math.fround(value)))) {
      invalid(`ramp_curve_m[${i}] 超出几何渲染精度范围`);
    }
    if (i) {
      const previous = copy[i - 1];
      if (point.x === previous.x && point.y === previous.y) {
        invalid(`ramp_curve_m[${i - 1}] 与 [${i}] 连续重复，构成退化段`);
      }
      if (Math.fround(point.x) === Math.fround(previous.x) && Math.fround(point.y) === Math.fround(previous.y)) {
        invalid(`ramp_curve_m[${i - 1}] 与 [${i}] 在几何渲染精度下构成退化段`);
      }
    }
    copy.push({ x: point.x, y: point.y });
  }
  return copy;
}

function normalBetween(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return new THREE.Vector3(-dy / length, dx / length, 0);
}

function framesFor(curve) {
  const last = curve.length - 1;
  const closed = curve[0].x === curve[last].x && curve[0].y === curve[last].y;
  return curve.map((point, i) => {
    const previous = curve[i === 0 ? (closed ? last - 1 : 0) : i - 1];
    const next = curve[i === last ? (closed ? 1 : last) : i + 1];
    // A central difference can cancel at a cusp. Its outgoing segment supplies
    // the frame there; the input surface itself is never smoothed or resampled.
    const normal = previous.x === next.x && previous.y === next.y
      ? normalBetween(point, curve[i === last ? i - 1 : i + 1])
      : normalBetween(previous, next);
    return { position: new THREE.Vector3(point.x, point.y, 0), normal };
  });
}

function geometry(vertices, indices) {
  if (!vertices.every((value) => Number.isFinite(Math.fround(value)))) {
    invalid('尺寸与坐标组合超出几何渲染精度范围');
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  result.setIndex(indices);
  result.computeVertexNormals();
  return result;
}

function mesh(name, geo, material) {
  const result = new THREE.Mesh(geo, material);
  result.name = name;
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

// Each ribbon keeps one pair of vertices at every original polyline sample.
function strips(name, frames, bands, material) {
  const vertices = [], indices = [];
  for (const { z0, z1, offset } of bands) {
    const start = vertices.length / 3;
    frames.forEach(({ position: p, normal: n }, i) => {
      for (const z of [z0, z1]) vertices.push(p.x + n.x * offset, p.y + n.y * offset, z);
      if (i) {
        const j = start + i * 2;
        indices.push(j - 2, j, j - 1, j, j + 1, j - 1);
      }
    });
  }
  return mesh(name, geometry(vertices, indices), material);
}

function deckSides(frames, width, thickness, material) {
  const vertices = [], indices = [];
  for (const z of [-width / 2, width / 2]) {
    const start = vertices.length / 3;
    frames.forEach(({ position: p, normal: n }, i) => {
      vertices.push(p.x, p.y, z, p.x - n.x * thickness, p.y - n.y * thickness, z);
      if (i) {
        const j = start + i * 2;
        indices.push(j - 2, j, j - 1, j, j + 1, j - 1);
      }
    });
  }
  for (const { position: p, normal: n } of [frames[0], frames.at(-1)]) {
    const j = vertices.length / 3;
    for (const offset of [0, -thickness]) {
      for (const z of [-width / 2, width / 2]) vertices.push(p.x + n.x * offset, p.y + n.y * offset, z);
    }
    indices.push(j, j + 2, j + 1, j + 1, j + 2, j + 3);
  }
  return mesh('Ramp_sides', geometry(vertices, indices), material);
}

function supportStations(frames) {
  const cumulative = [0];
  for (let i = 1; i < frames.length; i++) {
    cumulative.push(cumulative.at(-1) + frames[i].position.distanceTo(frames[i - 1].position));
  }
  const count = Math.min(MAX_FRAME_STATIONS, frames.length);
  const stations = [];
  let segment = 1;
  for (let i = 0; i < count; i++) {
    const distance = cumulative.at(-1) * i / (count - 1);
    while (segment < frames.length - 1 && cumulative[segment] < distance) segment++;
    const a = frames[segment - 1], b = frames[segment];
    const fraction = (distance - cumulative[segment - 1]) / (cumulative[segment] - cumulative[segment - 1]);
    stations.push({
      position: a.position.clone().lerp(b.position, fraction),
      normal: normalBetween(a.position, b.position),
    });
  }
  return stations;
}

function addBeam(group, name, a, b, radius, material) {
  const direction = b.clone().sub(a), length = direction.length();
  // Crossing/closed profiles can put two construction joints at the same spot.
  if (length === 0) return;
  const result = mesh(name, new THREE.CylinderGeometry(radius, radius, length, 6), material);
  result.position.copy(a).add(b).multiplyScalar(0.5);
  result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.divideScalar(length));
  group.add(result);
}

/** Build the solid reference-style deck along the supplied physics polyline. */
export function createCurveTrack(rampCurve, options = {}) {
  const curve = validateRampCurve(rampCurve);
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('options 必须是对象');
  const { width, thickness } = { ...DEFAULTS, ...options };
  for (const [key, value] of Object.entries({ width, thickness })) {
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || Math.fround(value) <= 0) {
      invalid(`${key} 必须是可渲染的正有限数字`);
    }
  }
  const frames = framesFor(curve);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of curve) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const group = new THREE.Group();
  group.name = 'Launch_Ramp_from_curve';
  group.userData = {
    type: 'physics-curve-reconstruction', units: 'm', rampCurve: curve,
    width, thickness, height: maxY - minY, span: maxX - minX,
    bounds: { minX, maxX, minY, maxY },
    surfaceInterpolation: 'linear',
    supportGeometry: 'visual reconstruction; not a structural calculation',
    cuspNormal: 'outgoing segment when adjacent tangents cancel',
  };
  const surface = new THREE.MeshStandardMaterial({ color: 0x586066, roughness: 0.86, metalness: 0.16, envMapIntensity: 0.4, side: THREE.DoubleSide });
  const edge = new THREE.MeshStandardMaterial({ color: 0xbc5149, roughness: 0.55, side: THREE.DoubleSide });
  const white = new THREE.MeshStandardMaterial({ color: 0xeeeae2, roughness: 0.7, side: THREE.DoubleSide });
  const steel = new THREE.MeshStandardMaterial({ color: 0x68717a, metalness: 0.75, roughness: 0.45, side: THREE.DoubleSide });
  group.add(strips('Ramp_surface', frames, [{ z0: -width / 2, z1: width / 2, offset: 0 }], surface));
  group.add(strips('Ramp_underside', frames, [{ z0: -width / 2, z1: width / 2, offset: -thickness }], steel));
  group.add(deckSides(frames, width, thickness, steel));
  // Preserve the reference paint proportions, including on unusually narrow decks.
  const edgeInset = Math.min(0.09, width * 0.04), edgeHalfWidth = Math.min(0.07, width * 0.03);
  group.add(strips('Ramp_edges', frames, [-1, 1].map((side) => ({
    z0: side * (width / 2 - edgeInset) - edgeHalfWidth,
    z1: side * (width / 2 - edgeInset) + edgeHalfWidth,
    offset: 0.025,
  })), edge));
  const lineHalfWidth = Math.min(0.035, width * 0.025);
  group.add(strips('Ramp_centerline', frames, [{ z0: -lineHalfWidth, z1: lineHalfWidth, offset: 0.023 }], white));

  const groundY = Math.min(0, minY);
  const firstRise = curve.findIndex((point) => point.y > groundY);
  const supportStartIndex = firstRise > 0 ? firstRise - 1 : 0;
  // Match the reference frame: reserve its stations for the rising ramp, not
  // the flat run-up. An entirely flat curve still receives its full frame.
  const stations = supportStations(frames.slice(supportStartIndex));
  group.userData.supportStationCount = stations.length;
  group.userData.supportStartIndex = supportStartIndex;
  const frontDepth = thickness + 0.04, backDepth = thickness + 1.37;
  const frame = stations.map(({ position, normal }) => ({
    front: position.clone().addScaledVector(normal, -frontDepth),
    back: position.clone().addScaledVector(normal, -backDepth),
  }));
  const truss = new THREE.Group(); truss.name = 'Ramp_truss';
  for (const side of [-1, 1]) {
    const z = side * (width / 2 + 0.12);
    frame.forEach((station, i) => {
      const front = station.front.clone().setZ(z), back = station.back.clone().setZ(z);
      addBeam(truss, 'Ramp_truss_rib', front, back, 0.06, steel);
      if (i) {
        const previous = frame[i - 1];
        addBeam(truss, 'Ramp_truss_front', previous.front.clone().setZ(z), front, 0.065, steel);
        addBeam(truss, 'Ramp_truss_back', previous.back.clone().setZ(z), back, 0.065, steel);
        addBeam(truss, 'Ramp_truss_diagonal', previous.back.clone().setZ(z), front, 0.045, steel);
      }
    });
    const supportIndices = new Set([0.33, 0.58, 0.83, 1].map((fraction) => Math.round((frame.length - 1) * fraction)));
    for (const i of supportIndices) {
      addBeam(truss, 'Ramp_truss_support', frame[i].back.clone().setZ(z), new THREE.Vector3(maxX + 2.7, groundY, z), 0.075, steel);
    }
  }
  frame.forEach((station, i) => {
    if (i % 2 === 0) addBeam(truss, 'Ramp_truss_tie', station.back.clone().setZ(-width / 2), station.back.clone().setZ(width / 2), 0.055, steel);
  });
  const base = mesh('Ramp_truss_base', new THREE.BoxGeometry(6, 0.18, width + 2), steel);
  base.position.set(maxX + 1, groundY + 0.09, 0);
  truss.add(base);
  group.add(truss);
  return group;
}
