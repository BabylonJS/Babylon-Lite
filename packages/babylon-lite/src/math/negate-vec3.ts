import type { Vec3 } from "./types.js";

/** Negate every vector component. */
export function negateVec3(v: Vec3): Vec3 {
    return { x: -v.x, y: -v.y, z: -v.z };
}
