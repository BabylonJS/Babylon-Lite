import type { Mat4 } from "./types.js";
import { mat4MultiplyInto } from "./mat4-multiply-into.js";

/** Multiply two Mat4: out = a * b (column-major). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16) as Mat4;
    mat4MultiplyInto(out, 0, a, 0, b, 0);
    return out;
}
