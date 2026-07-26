import type { Mat4Storage } from "./types.js";

/** Write a reverse-Z off-center orthographic projection into `out` without allocating.
 *  WebGPU clip-space depth is [0, 1]; like `mat4PerspectiveLHToRef` this maps
 *  `near -> 1` and `far -> 0`, so orthographic cameras share the engine's
 *  reverse-Z depth state (clear 0, compare `greater`).
 *
 *  This writer overwrites all 16 elements. `mat4PerspectiveLHToRef` writes only the five
 *  a perspective matrix needs (0, 5, 10, 11, 14) and assumes the rest of its target is
 *  already zero, so the two are not symmetric: switching perspective to orthographic is
 *  safe on a shared cache, while the reverse relies on `disableOrthographicCamera`
 *  clearing out[12], out[13] and out[15] before handing the cache back. Optional
 *  projectors fully overwrite their output so a future third projection type cannot be
 *  contaminated by whichever one ran before it.
 *  Storage may be F32- or F64-backed. */
export function mat4OrthoOffCenterLHToRef(out: Mat4Storage, left: number, right: number, bottom: number, top: number, near: number, far: number): void {
    const range = far - near;
    out[0] = 2 / (right - left);
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 2 / (top - bottom);
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = -1 / range;
    out[11] = 0;
    out[12] = (left + right) / (left - right);
    out[13] = (top + bottom) / (bottom - top);
    out[14] = far / range;
    out[15] = 1;
}
