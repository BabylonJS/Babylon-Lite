import type { Mat4 } from "./types.js";
import { mat4PerspectiveLHToRef } from "./mat4-perspective-lh-to-ref.js";

/** Perspective projection (left-handed, zero-to-one depth). Matches Babylon.js. */
export function mat4PerspectiveLH(fov: number, aspect: number, near: number, far: number): Mat4 {
    const out = new Float32Array(16) as Mat4;
    mat4PerspectiveLHToRef(out, fov, aspect, near, far);
    return out;
}
