import type { Vec3 } from "./types.js";

/** Subtract vector `b` from vector `a` component-wise. */
export function subtractVec3(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
