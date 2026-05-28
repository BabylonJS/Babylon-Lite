import type { Mat4 } from "./types.js";
import { mat4ComposeInto } from "./mat4-compose-into.js";

/** Create a rotation matrix from a quaternion. */
export function mat4FromQuat(qx: number, qy: number, qz: number, qw: number): Mat4 {
    const out = new Float32Array(16);
    mat4ComposeInto(out, 0, 0, 0, 0, qx, qy, qz, qw, 1, 1, 1);
    return out as unknown as Mat4;
}
