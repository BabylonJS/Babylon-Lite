import type { Vec3 } from "./types.js";

export function scaleVec3(v: Vec3, s: number): Vec3 {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
}
