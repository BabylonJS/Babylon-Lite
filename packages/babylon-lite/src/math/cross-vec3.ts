import type { Vec3 } from "./types.js";

/** Compute the right-handed cross product `a x b`. */
export function crossVec3(a: Vec3, b: Vec3): Vec3 {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}
