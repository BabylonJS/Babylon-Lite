import type { Mat4Storage } from "./types.js";

/** Write a reverse-Z off-center orthographic projection into `out` without allocating.
 *  WebGPU clip-space depth is [0, 1]; like `mat4PerspectiveLHToRef` this maps
 *  `near -> 1` and `far -> 0`, so orthographic cameras share the engine's
 *  reverse-Z depth state (clear 0, compare `greater`).
 *
 *  This writer covers every element `mat4PerspectiveLHToRef` writes (including
 *  `out[11]`, which it sets to 0 rather than 1), so switching perspective to
 *  orthographic on a shared cache leaves no stale perspective terms behind.
 *  The reverse direction is *not* symmetric: `out[12]`, `out[13]`, and `out[15]`
 *  are written only here, and the perspective writer assumes they are already
 *  zero, so `disableOrthographicCamera` clears them when handing the cache back.
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
