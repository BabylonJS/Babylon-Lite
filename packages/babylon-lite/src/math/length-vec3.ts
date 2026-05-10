import type { Vec3 } from "./types.js";

export function lengthVec3(v: Vec3): number {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
