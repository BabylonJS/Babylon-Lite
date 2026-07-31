import type { Mat4Storage, Vec3 } from "./types.js";

/** Write the camera-to-world matrix for an eye looking at `target` — the inverse of the
 *  `mat4LookAtLH` view matrix, built directly instead of by inverting one.
 *
 *  Every camera factory needs this, not a view matrix: the engine stores a camera's *world*
 *  matrix (so cameras parent like any other node) and derives the view matrix from it in
 *  `getViewMatrix`. Routing through `mat4LookAtLH` meant, on every camera move, allocating a
 *  view matrix, computing a translation column that was immediately discarded, and then
 *  transposing the rotation back out of it. The basis is the same three vectors either way,
 *  so this writes them straight into the caller's storage: columns `[xAxis, yAxis, zAxis, eye]`.
 *
 *  Degenerate input — eye on target, or the view direction parallel to `up` — leaves an
 *  identity rotation with the eye translation, matching `mat4LookAtLH`'s identity fallback. */
export function mat4LookAtWorldLHToRef(out: Mat4Storage, eye: Vec3, target: Vec3, up: Vec3): void {
    out[3] = 0;
    out[7] = 0;
    out[11] = 0;
    out[12] = eye.x;
    out[13] = eye.y;
    out[14] = eye.z;
    out[15] = 1;

    // Left-handed: +Z points from the eye towards the target.
    let zx = target.x - eye.x;
    let zy = target.y - eye.y;
    let zz = target.z - eye.z;
    const zLen = Math.sqrt(zx * zx + zy * zy + zz * zz);
    let xx = 0;
    let xy = 0;
    let xz = 0;
    let xLen = 0;
    if (zLen >= 1e-10) {
        const invZ = 1 / zLen;
        zx *= invZ;
        zy *= invZ;
        zz *= invZ;
        // xAxis = cross(up, zAxis)
        xx = up.y * zz - up.z * zy;
        xy = up.z * zx - up.x * zz;
        xz = up.x * zy - up.y * zx;
        xLen = Math.sqrt(xx * xx + xy * xy + xz * xz);
    }
    if (xLen < 1e-10) {
        out[0] = 1;
        out[1] = 0;
        out[2] = 0;
        out[4] = 0;
        out[5] = 1;
        out[6] = 0;
        out[8] = 0;
        out[9] = 0;
        out[10] = 1;
        return;
    }
    const invX = 1 / xLen;
    xx *= invX;
    xy *= invX;
    xz *= invX;

    out[0] = xx;
    out[1] = xy;
    out[2] = xz;
    // yAxis = cross(zAxis, xAxis) — already unit, both operands are.
    out[4] = zy * xz - zz * xy;
    out[5] = zz * xx - zx * xz;
    out[6] = zx * xy - zy * xx;
    out[8] = zx;
    out[9] = zy;
    out[10] = zz;
}
