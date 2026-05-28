import type { Mat4 } from "./types.js";

/** Create a new identity Mat4. */
export function mat4Identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m as unknown as Mat4;
}
