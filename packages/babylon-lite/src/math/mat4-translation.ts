import type { Mat4 } from "./types.js";
import { asMat4Storage } from "./_mat4-storage.js";
import { mat4Identity } from "./mat4-identity.js";

/** Create a translation matrix. */
export function mat4Translation(x: number, y: number, z: number): Mat4 {
    const out = mat4Identity();
    const s = asMat4Storage(out);
    s[12] = x;
    s[13] = y;
    s[14] = z;
    return out;
}
