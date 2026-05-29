import type { Mat4Storage } from "./types.js";

/** Multiply a[aOff..+16] * b[bOff..+16] into dst[dOff..+16] (fully unrolled, zero allocation).
 *  Parameters accept either F32- or F64-backed storage (`Mat4Storage`). */
export function mat4MultiplyInto(dst: Mat4Storage, d: number, a: Mat4Storage, i: number, b: Mat4Storage, j: number): void {
    const a0 = a[i]!,
        a1 = a[i + 1]!,
        a2 = a[i + 2]!,
        a3 = a[i + 3]!;
    const a4 = a[i + 4]!,
        a5 = a[i + 5]!,
        a6 = a[i + 6]!,
        a7 = a[i + 7]!;
    const a8 = a[i + 8]!,
        a9 = a[i + 9]!,
        a10 = a[i + 10]!,
        a11 = a[i + 11]!;
    const a12 = a[i + 12]!,
        a13 = a[i + 13]!,
        a14 = a[i + 14]!,
        a15 = a[i + 15]!;
    let b0 = b[j]!,
        b1 = b[j + 1]!,
        b2 = b[j + 2]!,
        b3 = b[j + 3]!;
    dst[d] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    dst[d + 1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    dst[d + 2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    dst[d + 3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
    b0 = b[j + 4]!;
    b1 = b[j + 5]!;
    b2 = b[j + 6]!;
    b3 = b[j + 7]!;
    dst[d + 4] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    dst[d + 5] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    dst[d + 6] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    dst[d + 7] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
    b0 = b[j + 8]!;
    b1 = b[j + 9]!;
    b2 = b[j + 10]!;
    b3 = b[j + 11]!;
    dst[d + 8] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    dst[d + 9] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    dst[d + 10] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    dst[d + 11] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
    b0 = b[j + 12]!;
    b1 = b[j + 13]!;
    b2 = b[j + 14]!;
    b3 = b[j + 15]!;
    dst[d + 12] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    dst[d + 13] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    dst[d + 14] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    dst[d + 15] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
}
