import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";
import { mat4Identity } from "./mat4-identity.js";

/** Create a translation matrix. */
export function mat4Translation(x: number, y: number, z: number): Mat4 {
    const out = mat4Identity();
    const s = out as unknown as Mat4Storage;
    s[12] = x;
    s[13] = y;
    s[14] = z;
    return out;
}
