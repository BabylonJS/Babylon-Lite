// Mat4 indexing is always safe (16-element Float32Array), suppress noUncheckedIndexedAccess.

import type { Mat4, Vec3 } from "./types.js";

// 4x4 column-major matrix.
// Index layout (column-major, matching WGSL mat4x4<f32>):
//   [0]  [4]  [8]  [12]
//   [1]  [5]  [9]  [13]
//   [2]  [6]  [10] [14]
//   [3]  [7]  [11] [15]

/** Create a new identity Mat4. */
export function mat4Identity(): Mat4 {
    const m = new Float32Array(16) as Mat4;
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m;
}

/** Multiply two Mat4: out = a * b (column-major). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16) as Mat4;
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            out[col * 4 + row] = a[row]! * b[col * 4]! + a[4 + row]! * b[col * 4 + 1]! + a[8 + row]! * b[col * 4 + 2]! + a[12 + row]! * b[col * 4 + 3]!;
        }
    }
    return out;
}

/** LookAt matrix (right-handed). Matches Babylon.js Matrix.LookAtLHToRef with LH convention. */
export function mat4LookAtLH(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    // Babylon.js uses LEFT-HANDED coordinate system
    const zAxis = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
    const zLen = Math.sqrt(zAxis.x * zAxis.x + zAxis.y * zAxis.y + zAxis.z * zAxis.z);
    if (zLen < 1e-10) {
        return mat4Identity();
    }
    const invZ = 1 / zLen;
    zAxis.x *= invZ;
    zAxis.y *= invZ;
    zAxis.z *= invZ;

    // xAxis = cross(up, zAxis)
    const xAxis = {
        x: up.y * zAxis.z - up.z * zAxis.y,
        y: up.z * zAxis.x - up.x * zAxis.z,
        z: up.x * zAxis.y - up.y * zAxis.x,
    };
    const xLen = Math.sqrt(xAxis.x * xAxis.x + xAxis.y * xAxis.y + xAxis.z * xAxis.z);
    if (xLen < 1e-10) {
        return mat4Identity();
    }
    const invX = 1 / xLen;
    xAxis.x *= invX;
    xAxis.y *= invX;
    xAxis.z *= invX;

    // yAxis = cross(zAxis, xAxis)
    const yAxis = {
        x: zAxis.y * xAxis.z - zAxis.z * xAxis.y,
        y: zAxis.z * xAxis.x - zAxis.x * xAxis.z,
        z: zAxis.x * xAxis.y - zAxis.y * xAxis.x,
    };

    const out = new Float32Array(16) as Mat4;
    out[0] = xAxis.x;
    out[1] = yAxis.x;
    out[2] = zAxis.x;
    out[3] = 0;
    out[4] = xAxis.y;
    out[5] = yAxis.y;
    out[6] = zAxis.y;
    out[7] = 0;
    out[8] = xAxis.z;
    out[9] = yAxis.z;
    out[10] = zAxis.z;
    out[11] = 0;
    out[12] = -(xAxis.x * eye.x + xAxis.y * eye.y + xAxis.z * eye.z);
    out[13] = -(yAxis.x * eye.x + yAxis.y * eye.y + yAxis.z * eye.z);
    out[14] = -(zAxis.x * eye.x + zAxis.y * eye.y + zAxis.z * eye.z);
    out[15] = 1;
    return out;
}

/** Perspective projection (left-handed, zero-to-one depth). Matches Babylon.js. */
export function mat4PerspectiveLH(fov: number, aspect: number, near: number, far: number): Mat4 {
    const tan = 1 / Math.tan(fov * 0.5);
    const range = far - near;

    const out = new Float32Array(16) as Mat4;
    out[0] = tan / aspect;
    out[5] = tan;
    out[10] = far / range;
    out[11] = 1;
    out[14] = -(far * near) / range;
    // out[15] = 0 — already zero from Float32Array init
    return out;
}

export { mat4Invert } from "./mat4-invert.js";

/** Create a scaling matrix. */
export function mat4Scale(x: number, y: number, z: number): Mat4 {
    const out = new Float32Array(16) as Mat4;
    out[0] = x;
    out[5] = y;
    out[10] = z;
    out[15] = 1;
    return out;
}

/** Create a translation matrix. */
export function mat4Translation(x: number, y: number, z: number): Mat4 {
    const out = mat4Identity();
    out[12] = x;
    out[13] = y;
    out[14] = z;
    return out;
}

/** Create a rotation matrix from a quaternion. */
export function mat4FromQuat(qx: number, qy: number, qz: number, qw: number): Mat4 {
    const xx = qx * qx,
        yy = qy * qy,
        zz = qz * qz;
    const xy = qx * qy,
        xz = qx * qz,
        yz = qy * qz;
    const wx = qw * qx,
        wy = qw * qy,
        wz = qw * qz;

    const out = new Float32Array(16) as Mat4;
    out[0] = 1 - 2 * (yy + zz);
    out[1] = 2 * (xy + wz);
    out[2] = 2 * (xz - wy);
    out[4] = 2 * (xy - wz);
    out[5] = 1 - 2 * (xx + zz);
    out[6] = 2 * (yz + wx);
    out[8] = 2 * (xz + wy);
    out[9] = 2 * (yz - wx);
    out[10] = 1 - 2 * (xx + yy);
    out[15] = 1;
    return out;
}

/** Compose TRS (translation * rotation * scale) into a single Mat4. */
export function mat4Compose(tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): Mat4 {
    const rot = mat4FromQuat(qx, qy, qz, qw);
    // Apply scale to rotation columns, then set translation
    rot[0]! *= sx;
    rot[1]! *= sx;
    rot[2]! *= sx;
    rot[4]! *= sy;
    rot[5]! *= sy;
    rot[6]! *= sy;
    rot[8]! *= sz;
    rot[9]! *= sz;
    rot[10]! *= sz;
    rot[12] = tx;
    rot[13] = ty;
    rot[14] = tz;
    return rot;
}

// ─── Zero-allocation helpers for per-frame animation ─────────────────

/** Compose TRS directly into a Float32Array at offset (zero allocation). */
export function mat4ComposeInto(
    dst: Float32Array,
    off: number,
    tx: number,
    ty: number,
    tz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    sx: number,
    sy: number,
    sz: number
): void {
    const xx = qx * qx,
        yy = qy * qy,
        zz = qz * qz;
    const xy = qx * qy,
        xz = qx * qz,
        yz = qy * qz;
    const wx = qw * qx,
        wy = qw * qy,
        wz = qw * qz;
    dst[off] = (1 - 2 * (yy + zz)) * sx;
    dst[off + 1] = 2 * (xy + wz) * sx;
    dst[off + 2] = 2 * (xz - wy) * sx;
    dst[off + 3] = 0;
    dst[off + 4] = 2 * (xy - wz) * sy;
    dst[off + 5] = (1 - 2 * (xx + zz)) * sy;
    dst[off + 6] = 2 * (yz + wx) * sy;
    dst[off + 7] = 0;
    dst[off + 8] = 2 * (xz + wy) * sz;
    dst[off + 9] = 2 * (yz - wx) * sz;
    dst[off + 10] = (1 - 2 * (xx + yy)) * sz;
    dst[off + 11] = 0;
    dst[off + 12] = tx;
    dst[off + 13] = ty;
    dst[off + 14] = tz;
    dst[off + 15] = 1;
}

/** Multiply a[aOff..+16] * b[bOff..+16] into dst[dOff..+16] (fully unrolled, zero allocation). */
export function mat4MultiplyInto(dst: Float32Array, d: number, a: Float32Array, i: number, b: Float32Array, j: number): void {
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
