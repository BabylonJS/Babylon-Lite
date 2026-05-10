import type { Mat4 } from "./types.js";
import { mat4Identity } from "./mat4-identity.js";

/** Create a translation matrix. */
export function mat4Translation(x: number, y: number, z: number): Mat4 {
    const out = mat4Identity();
    out[12] = x;
    out[13] = y;
    out[14] = z;
    return out;
}
