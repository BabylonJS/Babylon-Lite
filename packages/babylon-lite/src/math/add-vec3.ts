import type { Vec3 } from "./types.js";

/** Add two vectors component-wise. */
export function addVec3(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
