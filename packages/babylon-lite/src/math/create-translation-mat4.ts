import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";
import { createIdentityMat4 } from "./create-identity-mat4.js";

/** Create a translation matrix. */
export function createTranslationMat4(x: number, y: number, z: number): Mat4 {
    const out = createIdentityMat4();
    const s = out as unknown as Mat4Storage;
    s[12] = x;
    s[13] = y;
    s[14] = z;
    return out;
}
