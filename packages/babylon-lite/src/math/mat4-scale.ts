import type { Mat4 } from "./types.js";
import { allocateMat4 } from "./_matrix-allocator.js";
import type { Mat4Storage } from "./types.js";

/** Create a scaling matrix. */
export function mat4Scale(x: number, y: number, z: number): Mat4 {
    const out = allocateMat4() as unknown as Mat4Storage;
    out[0] = x;
    out[5] = y;
    out[10] = z;
    out[15] = 1;
    return out as unknown as Mat4;
}
