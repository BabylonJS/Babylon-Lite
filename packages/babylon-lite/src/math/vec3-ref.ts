import type { Vec3 } from "./types.js";

/** Add two vectors into `out`. */
export function addVec3ToRef(a: Vec3, b: Vec3, out: Vec3): Vec3 {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    out.z = a.z + b.z;
    return out;
}

/** Add `b` into `target`. */
export function addVec3InPlace(target: Vec3, b: Vec3): Vec3 {
    return addVec3ToRef(target, b, target);
}

/** Subtract vector `b` from vector `a` into `out`. */
export function subVec3ToRef(a: Vec3, b: Vec3, out: Vec3): Vec3 {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    out.z = a.z - b.z;
    return out;
}

/** Subtract `b` from `target`. */
export function subVec3InPlace(target: Vec3, b: Vec3): Vec3 {
    return subVec3ToRef(target, b, target);
}

/** Multiply every component of `v` by scalar `s` into `out`. */
export function scaleVec3ToRef(v: Vec3, s: number, out: Vec3): Vec3 {
    out.x = v.x * s;
    out.y = v.y * s;
    out.z = v.z * s;
    return out;
}

/** Multiply every component of `target` by scalar `s`. */
export function scaleVec3InPlace(target: Vec3, s: number): Vec3 {
    return scaleVec3ToRef(target, s, target);
}

/** Compute the right-handed cross product `a x b` into `out`. */
export function crossVec3ToRef(a: Vec3, b: Vec3, out: Vec3): Vec3 {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
}

/** Replace `target` with `target x b`. */
export function crossVec3InPlace(target: Vec3, b: Vec3): Vec3 {
    return crossVec3ToRef(target, b, target);
}

/** Normalize `v` into `out`, writing zero for degenerate input. */
export function normalizeVec3ToRef(v: Vec3, out: Vec3, epsilon = 1e-10): Vec3 {
    const len = Math.hypot(v.x, v.y, v.z);
    if (len <= epsilon) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        return out;
    }
    const inv = 1 / len;
    out.x = v.x * inv;
    out.y = v.y * inv;
    out.z = v.z * inv;
    return out;
}

/** Normalize `target` in place, writing zero for degenerate input. */
export function normalizeVec3InPlace(target: Vec3, epsilon = 1e-10): Vec3 {
    return normalizeVec3ToRef(target, target, epsilon);
}

/** Negate every vector component into `out`. */
export function negateVec3ToRef(v: Vec3, out: Vec3): Vec3 {
    out.x = -v.x;
    out.y = -v.y;
    out.z = -v.z;
    return out;
}

/** Negate `target` in place. */
export function negateVec3InPlace(target: Vec3): Vec3 {
    return negateVec3ToRef(target, target);
}

/** Linearly interpolate from vector `a` to vector `b` by factor `t` into `out`. */
export function lerpVec3ToRef(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
}

/** Linearly interpolate `target` toward `b` by factor `t`. */
export function lerpVec3InPlace(target: Vec3, b: Vec3, t: number): Vec3 {
    return lerpVec3ToRef(target, b, t, target);
}
