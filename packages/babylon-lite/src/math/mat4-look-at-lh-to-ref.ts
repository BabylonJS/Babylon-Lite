import type { Mat4Storage, Vec3 } from "./types.js";

/** Write an LH look-at view matrix into `out` without allocating. Matches
 *  Babylon.js Matrix.LookAtLHToRef. Storage may be F32- or F64-backed.
 *
 *  Degenerate input (eye on target, or the view direction parallel to `up`)
 *  writes a pure identity matrix, matching `mat4LookAtLH`'s previous
 *  identity-fallback behaviour. This writer fully overwrites all 16 elements
 *  on every path — see the "writers fully overwrite" convention noted in
 *  `mat4-ortho-lh-to-ref.ts`. */
export function mat4LookAtLHToRef(out: Mat4Storage, eye: Vec3, target: Vec3, up: Vec3): void {
    // Babylon.js uses LEFT-HANDED coordinate system
    const zAxis = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
    const zLen = Math.sqrt(zAxis.x * zAxis.x + zAxis.y * zAxis.y + zAxis.z * zAxis.z);
    if (zLen < 1e-10) {
        _writeIdentityInto(out);
        return;
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
        _writeIdentityInto(out);
        return;
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
}

function _writeIdentityInto(out: Mat4Storage): void {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 1;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = 1;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
}
