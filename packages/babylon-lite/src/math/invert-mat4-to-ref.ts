import type { Mat4Storage } from "./types.js";

/** @internal Write an inverse without allocation; reject relative singularity or unrepresentable output. */
export function tryInvertMat4ToRef(input: Mat4Storage, result: Mat4Storage): boolean {
    const a00 = input[0]!,
        a01 = input[1]!,
        a02 = input[2]!,
        a03 = input[3]!;
    const a10 = input[4]!,
        a11 = input[5]!,
        a12 = input[6]!,
        a13 = input[7]!;
    const a20 = input[8]!,
        a21 = input[9]!,
        a22 = input[10]!,
        a23 = input[11]!;
    const a30 = input[12]!,
        a31 = input[13]!,
        a32 = input[14]!,
        a33 = input[15]!;

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    // Bound all determinant products before cancellation, including cancellation inside the minors.
    const magnitude =
        (Math.abs(a00 * a11) + Math.abs(a01 * a10)) * (Math.abs(a22 * a33) + Math.abs(a23 * a32)) +
        (Math.abs(a00 * a12) + Math.abs(a02 * a10)) * (Math.abs(a21 * a33) + Math.abs(a23 * a31)) +
        (Math.abs(a00 * a13) + Math.abs(a03 * a10)) * (Math.abs(a21 * a32) + Math.abs(a22 * a31)) +
        (Math.abs(a01 * a12) + Math.abs(a02 * a11)) * (Math.abs(a20 * a33) + Math.abs(a23 * a30)) +
        (Math.abs(a01 * a13) + Math.abs(a03 * a11)) * (Math.abs(a20 * a32) + Math.abs(a22 * a30)) +
        (Math.abs(a02 * a13) + Math.abs(a03 * a12)) * (Math.abs(a20 * a31) + Math.abs(a21 * a30));
    if (!Number.isFinite(det) || Math.abs(det) <= 1e-10 * magnitude) {
        return false;
    }
    det = 1 / det;

    result[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    result[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    result[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    result[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    result[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    result[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    result[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    result[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    result[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    result[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    result[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    result[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    result[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    result[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    result[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    result[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    for (let index = 0; index < 16; index++) {
        if (!Number.isFinite(result[index])) {
            return false;
        }
    }
    return true;
}
