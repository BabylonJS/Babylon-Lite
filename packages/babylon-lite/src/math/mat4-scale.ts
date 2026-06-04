import type { Mat4 } from "./types.js";

/** Create a scaling matrix. */
export function mat4Scale(x: number, y: number, z: number): Mat4 {
    const out = new Float32Array(16);
    out[0] = x;
    out[5] = y;
    out[10] = z;
    out[15] = 1;
    return out as unknown as Mat4;
}
