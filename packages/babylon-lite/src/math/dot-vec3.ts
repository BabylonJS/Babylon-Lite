import type { Vec3 } from "./types.js";

/** Compute the dot product of two vectors. */
export function dotVec3(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
