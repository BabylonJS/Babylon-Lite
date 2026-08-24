import type { Mat4 } from "./types.js";
import { allocateMat4 } from "./_matrix-allocator.js";
import type { Mat4Storage } from "./types.js";

/** Create a new identity Mat4. */
export function mat4Identity(): Mat4 {
    const m = allocateMat4() as unknown as Mat4Storage;
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m as unknown as Mat4;
}
