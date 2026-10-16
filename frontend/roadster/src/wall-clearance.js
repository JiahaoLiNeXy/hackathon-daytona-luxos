import { Matrix3, Matrix4, Vector3 } from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import { CAR_DIMENSIONS } from './car.js';
import { adaptPhysicsResult } from './physics-adapter.js';
import { sampleTrajectory } from './trajectory.js';

const MAX_COORDINATE = 10_000_000;
const MAX_CHECKS = 100_000;
const MAX_DEPTH = 32;
const ENVELOPE_TOLERANCE = 0.03;
const METHOD = 'Conservative continuous Three.js OBB envelopes over every piecewise-linear position / shortest-arc quaternion-slerp segment. Car center uses the display-only rotated local +Y offset (height*scale/2 + 0.04 m). Clearance expands every local OBB half-extent; residual motion inflation is at most 0.03 m per half-extent at a reported hit. A collision is a possible safety-envelope overlap, not exact body contact or time of impact. firstHit.t is the earliest candidate interval midpoint in playback time; position remains the raw interpolated backend point. clearanceM is null because no minimum geometric distance is computed.';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function bounded(value, name, positive = false) {
  requireValue(Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE && (!positive || value > 0),
    `${name} must be a finite ${positive ? 'positive ' : ''}number within ${MAX_COORDINATE} m.`);
}

function displayedPose(trajectory, t, offset) {
  const pose = sampleTrajectory(trajectory, t);
  return {
    ...pose,
    displayPosition: pose.position.clone().add(new Vector3(0, offset, 0).applyQuaternion(pose.quaternion)),
  };
}

function carBox(pose, halfSize, inflation) {
  const rotation = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(pose.quaternion));
  return new OBB(pose.displayPosition, halfSize.clone().addScalar(inflation), rotation);
}

/**
 * Assess the complete validated physics trajectory against a wall standing on
 * y=0, centered at (wall.x, wall.height/2, 0). Coordinates and headings match
 * the existing renderer, including its zero-speed heading hold. No DOM needed.
 * Invalid data or exhausted numerical/work limits return invalid, never clear.
 */
export function assessWall(envelope, wall, options = {}) {
  let checkedSegments = 0;
  const base = (status, extra = {}) => ({ status, firstHit: null, clearanceM: null, checkedSegments, method: METHOD, ...extra });
  try {
    requireValue(options && typeof options === 'object' && !Array.isArray(options), 'options must be an object.');
    const { scale = 1, clearance = 0.15 } = options;
    requireValue(Number.isFinite(scale) && scale > 0 && scale <= 100, 'scale must be greater than 0 and at most 100.');
    requireValue(Number.isFinite(clearance) && clearance >= 0 && clearance <= 100, 'clearance must be between 0 and 100 m.');
    requireValue(wall && typeof wall === 'object' && !Array.isArray(wall), 'wall must be an object.');
    requireValue(typeof wall.enabled === 'boolean', 'wall.enabled must be a boolean.');
    const { x, height, width = 8, thickness = 0.35 } = wall;
    bounded(x, 'wall.x');
    for (const [key, value] of Object.entries({ height, width, thickness })) bounded(value, `wall.${key}`, true);

    // Reuse the existing envelope validation and exactly the renderer's heading
    // policy, including a +X initial heading and holding it at zero velocity.
    const { trajectory, phases } = adaptPhysicsResult(envelope);
    for (const sample of trajectory.samples) {
      bounded(sample.position[0], 'trajectory.x');
      bounded(sample.position[1], 'trajectory.y');
    }
    const details = { safetyMarginM: clearance, timeOffset: trajectory.timeOffset, envelopeToleranceM: ENVELOPE_TOLERANCE };
    if (!wall.enabled) return base('clear', { ...details, method: `${METHOD} Wall disabled; no obstacle was tested.` });

    const wallBox = new OBB(new Vector3(x, height / 2, 0), new Vector3(thickness / 2, height / 2, width / 2));
    const offset = CAR_DIMENSIONS.height * scale / 2 + 0.04;
    const halfSize = new Vector3(CAR_DIMENSIONS.length, CAR_DIMENSIONS.height, CAR_DIMENSIONS.width)
      .multiplyScalar(scale / 2).addScalar(clearance);
    // Radius from the RAW point to the farthest corner of the buffered car.
    // It includes the rotated display offset as well as the OBB half-extents.
    const radius = Math.hypot(halfSize.x, halfSize.y + offset, halfSize.z);
    const numericalPad = (radius + 1) * 1e-7 + MAX_COORDINATE * Number.EPSILON * 16;
    const phaseAt = (t) => {
      let low = 0, high = phases.length;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (phases[middle].t <= t) low = middle;
        else high = middle;
      }
      return phases[low].phase;
    };
    const hit = (t, pose, interval, error) => ({
      t, position: pose.position.toArray(), displayPosition: pose.displayPosition.toArray(),
      phase: phaseAt(t), interval, conservative: true, envelopeErrorM: error,
    });
    const intersects = (pose, error) => {
      requireValue(++checkedSegments <= MAX_CHECKS, `Continuous wall assessment exceeded ${MAX_CHECKS} interval checks.`);
      return carBox(pose, halfSize, error).intersectsOBB(wallBox);
    };

    function visit(t0, t1, start, end, depth) {
      const middle = t0 + (t1 - t0) / 2;
      const pose = displayedPose(trajectory, middle, offset);
      // A point of a rotating body moves at most 2R sin(deltaAngle/2).
      // From an interval midpoint, max deltaAngle is half the full slerp arc.
      // Raw translation is linear, so its maximum displacement is half the
      // endpoint distance. Adding these bounds encloses EVERY intervening pose.
      const motion = start.position.distanceTo(end.position) / 2
        + 2 * radius * Math.sin(start.quaternion.angleTo(end.quaternion) / 4)
        + numericalPad;
      requireValue(Number.isFinite(motion), 'The continuous motion bound is not finite.');
      if (!intersects(pose, motion)) return null;
      if (motion <= ENVELOPE_TOLERANCE) return hit(middle, pose, [t0, t1], motion);
      requireValue(depth < MAX_DEPTH, `Continuous wall assessment exceeded subdivision depth ${MAX_DEPTH}.`);
      requireValue(middle > t0 && middle < t1, 'Trajectory time precision is insufficient for continuous assessment.');
      // Search in time order. A later return through the wall is considered if
      // the first crossing was clear; stop only after the earliest possible hit.
      return visit(t0, middle, start, pose, depth + 1) || visit(middle, t1, pose, end, depth + 1);
    }

    let previousTime = trajectory.samples[0].t;
    let previous = displayedPose(trajectory, previousTime, offset);
    if (intersects(previous, numericalPad)) {
      return base('collision', { ...details, firstHit: hit(previousTime, previous, [previousTime, previousTime], numericalPad) });
    }
    for (let i = 1; i < trajectory.samples.length; i++) {
      const nextTime = trajectory.samples[i].t;
      const next = displayedPose(trajectory, nextTime, offset);
      const firstHit = visit(previousTime, nextTime, previous, next, 0);
      if (firstHit) return base('collision', { ...details, firstHit });
      previous = next;
      previousTime = nextTime;
    }
    return base('clear', details);
  } catch (error) {
    return base('invalid', { reason: error instanceof Error ? error.message : String(error) });
  }
}
