import type { Vec3 } from "./types.js";

/** Linearly interpolate from vector `a` to vector `b` by factor `t`. */
export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
    };
}
