import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";
import { mat4MultiplyInto } from "./mat4-multiply-into.js";

/** Multiply two Mat4: out = a * b (column-major). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
    const out: Mat4Storage = new Float32Array(16);
    mat4MultiplyInto(out, 0, a as unknown as Mat4Storage, 0, b as unknown as Mat4Storage, 0);
    return out as unknown as Mat4;
}
