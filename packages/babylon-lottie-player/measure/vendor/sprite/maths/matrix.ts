import { type IVector2Like } from "../babylonTypes";

/**
 * A 4x4 column-major matrix stored as a flat 16-element `Float32Array`.
 *
 * The Lottie renderer only ever needs 2D affine transforms, so most helpers below read and write
 * just the six components used for 2D (m0, m1, m4, m5 for scale/rotation and m12, m13 for
 * translation). The full 16 components are only populated for the identity "view" matrix and the
 * orthographic projection matrix uploaded to the GPU.
 *
 * Kept intentionally minimal to avoid depending on a full matrix math system.
 */
export type Matrix = Float32Array;

/**
 * Creates a new zero-initialized 4x4 matrix.
 * @returns A new 16-element matrix.
 */
export function createMatrix(): Matrix {
    return new Float32Array(16);
}

/**
 * Sets a matrix to the identity matrix.
 * @param out The matrix to write into.
 */
export function setMatrixIdentity(out: Matrix): void {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
}

/**
 * Stores a left-handed off-center orthographic projection into a matrix.
 * @param out The matrix to write into.
 * @param left The viewport left coordinate.
 * @param right The viewport right coordinate.
 * @param bottom The viewport bottom coordinate.
 * @param top The viewport top coordinate.
 * @param znear The near clip plane.
 * @param zfar The far clip plane.
 */
export function setMatrixOrtho(out: Matrix, left: number, right: number, bottom: number, top: number, znear: number, zfar: number): void {
    const a = 2.0 / (right - left);
    const b = 2.0 / (top - bottom);
    const c = 2.0 / (zfar - znear);
    const d = -(zfar + znear) / (zfar - znear);
    const i0 = (left + right) / (left - right);
    const i1 = (top + bottom) / (bottom - top);

    out[0] = a;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = b;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = c;
    out[11] = 0;
    out[12] = i0;
    out[13] = i1;
    out[14] = d;
    out[15] = 1.0;
}

/**
 * Composes a 2D affine transform (scale, z-rotation, translation) into a matrix.
 * Only the six components used for 2D transforms are written.
 * @param out The matrix to write into.
 * @param scale The scale vector.
 * @param roll The rotation around z, in radians.
 * @param translation The translation vector.
 */
export function composeMatrix(out: Matrix, scale: IVector2Like, roll: number, translation: IVector2Like): void {
    // Produces a quaternion from a single z (roll) rotation, then expands its 2x2 rotation block.
    const halfRoll = roll * 0.5;
    const z = Math.sin(halfRoll);
    const w = Math.cos(halfRoll);

    const z2 = z + z;
    const zz = z * z2;
    const wz = w * z2;

    const sx = scale.x;
    const sy = scale.y;

    out[0] = (1 - zz) * sx;
    out[1] = wz * sx;
    out[4] = -wz * sy;
    out[5] = (1 - zz) * sy;
    out[12] = translation.x;
    out[13] = translation.y;
}

/**
 * Multiplies two 2D affine matrices, writing `a * b` into `out`.
 * Only the six 2D-affine components are computed. All inputs are read before any write, so `out` may
 * safely alias `a` or `b`.
 * @param a The first operand.
 * @param b The second operand.
 * @param out The matrix to store the result into.
 */
export function multiplyMatricesToRef(a: Matrix, b: Matrix, out: Matrix): void {
    const a0 = a[0];
    const a1 = a[1];
    const a4 = a[4];
    const a5 = a[5];
    const a12 = a[12];
    const a13 = a[13];

    const b0 = b[0];
    const b1 = b[1];
    const b4 = b[4];
    const b5 = b[5];
    const b12 = b[12];
    const b13 = b[13];

    out[0] = a0 * b0 + a1 * b4;
    out[1] = a0 * b1 + a1 * b5;
    out[4] = a4 * b0 + a5 * b4;
    out[5] = a4 * b1 + a5 * b5;
    out[12] = a12 * b0 + a13 * b4 + b12;
    out[13] = a12 * b1 + a13 * b5 + b13;
}

/**
 * Decomposes a 2D affine matrix into scale, rotation, and translation.
 * @param m The matrix to decompose.
 * @param scale Output vector to receive the decomposed scale.
 * @param translation Output vector to receive the decomposed translation.
 * @returns The rotation in radians.
 */
export function decomposeMatrix(m: Matrix, scale: IVector2Like, translation: IVector2Like): number {
    const m00 = m[0]; // scaleX * cos(θ)
    const m01 = m[1]; // -scaleY * sin(θ)
    const m10 = m[4]; // scaleX * sin(θ)
    const m11 = m[5]; // scaleY * cos(θ)

    // Extract scale from the column lengths.
    scale.x = Math.hypot(m00, m10); // sqrt(m00² + m10²)
    scale.y = Math.hypot(m01, m11); // sqrt(m01² + m11²)

    // Extract rotation from the first column (assumes uniform scaling or affine 2D).
    const rotation = Math.atan2(m10, m00);

    // Extract the translation.
    translation.x = m[12];
    translation.y = m[13];

    return rotation;
}
