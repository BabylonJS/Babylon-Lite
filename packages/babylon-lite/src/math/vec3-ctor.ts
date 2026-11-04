import type { Vec3 } from "./types.js";

/** Create a plain `{ x, y, z }` vector object. */
export function vec3(x: number, y: number, z: number): Vec3 {
    return { x, y, z };
}
