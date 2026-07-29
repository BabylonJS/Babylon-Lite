import { F32 } from "../engine/typed-arrays.js";
import type { Mat4 } from "./types.js";
import { mat4ComposeInto } from "./mat4-compose-into.js";

/** Write a rotation matrix from a quaternion into an existing matrix buffer. */
export function mat4FromQuatInto<T extends Float32Array | Float64Array>(out: T, qx: number, qy: number, qz: number, qw: number): T {
    mat4ComposeInto(out, 0, 0, 0, 0, qx, qy, qz, qw, 1, 1, 1);
    return out;
}

/** Create a rotation matrix from a quaternion. */
export function mat4FromQuat(qx: number, qy: number, qz: number, qw: number): Mat4 {
    const out = new F32(16);
    mat4ComposeInto(out, 0, 0, 0, 0, qx, qy, qz, qw, 1, 1, 1);
    return out as unknown as Mat4;
}
