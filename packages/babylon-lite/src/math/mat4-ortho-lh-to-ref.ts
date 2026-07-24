import type { Mat4Storage } from "./types.js";

/** Write a reverse-Z off-center orthographic projection into `out` without allocating.
 *  WebGPU clip-space depth is [0, 1]; like `mat4PerspectiveLHToRef` this maps
 *  `near -> 1` and `far -> 0`, so orthographic cameras share the engine's
 *  reverse-Z depth state (clear 0, compare `greater`).
 *
 *  Every element the perspective writer touches is written here too — including
 *  `out[11] = 0` and `out[15] = 1` — so a camera may be switched between
 *  projections without stale terms surviving in the shared cache.
 *  Storage may be F32- or F64-backed. */
export function mat4OrthoOffCenterLHToRef(out: Mat4Storage, left: number, right: number, bottom: number, top: number, near: number, far: number): void {
    const range = far - near;
    out[0] = 2 / (right - left);
    out[5] = 2 / (top - bottom);
    out[10] = -1 / range;
    out[11] = 0;
    out[12] = (left + right) / (left - right);
    out[13] = (top + bottom) / (bottom - top);
    out[14] = far / range;
    out[15] = 1;
}
