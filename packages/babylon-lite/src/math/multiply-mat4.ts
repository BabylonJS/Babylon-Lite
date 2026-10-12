import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";
import { multiplyMat4IntoBuffer } from "./multiply-mat4-into-buffer.js";
import { allocateMat4 } from "./_matrix-allocator.js";

/** Multiply two Mat4: out = a * b (column-major). */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
    const out: Mat4Storage = allocateMat4() as unknown as Mat4Storage;
    multiplyMat4IntoBuffer(out, 0, a as unknown as Mat4Storage, 0, b as unknown as Mat4Storage, 0);
    return out as unknown as Mat4;
}
