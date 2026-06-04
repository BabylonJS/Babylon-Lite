import type { Mat4, Vec3 } from "./types.js";
import { mat4Identity } from "./mat4-identity.js";

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

    return new Float32Array([
        xAxis.x,
        yAxis.x,
        zAxis.x,
        0,
        xAxis.y,
        yAxis.y,
        zAxis.y,
        0,
        xAxis.z,
        yAxis.z,
        zAxis.z,
        0,
        -(xAxis.x * eye.x + xAxis.y * eye.y + xAxis.z * eye.z),
        -(yAxis.x * eye.x + yAxis.y * eye.y + yAxis.z * eye.z),
        -(zAxis.x * eye.x + zAxis.y * eye.y + zAxis.z * eye.z),
        1,
    ]) as unknown as Mat4;
}
