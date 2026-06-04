import type { Mat4Storage } from "./types.js";

/** Write a reverse-Z perspective projection into `out` without allocating.
/** Write a reverse-Z perspective projection into `out` without allocating.
 *  WebGPU clip-space depth is [0, 1]; this maps `near -> 1` and `far -> 0`.
 *  Storage may be F32- or F64-backed. */
export function mat4PerspectiveLHToRef(out: Mat4Storage, fov: number, aspect: number, near: number, far: number): void {
    const tan = 1 / Math.tan(fov * 0.5);
    const range = far - near;
    out[0] = tan / aspect;
    out[5] = tan;
    out[10] = -near / range;
    out[11] = 1;
    out[14] = (far * near) / range;
}
