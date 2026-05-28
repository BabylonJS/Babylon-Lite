import type { Mat4 } from "./types.js";
import { mat4PerspectiveLHToRef } from "./mat4-perspective-lh-to-ref.js";

/** Reverse-Z perspective projection (left-handed, zero-to-one depth). */
export function mat4PerspectiveLH(fov: number, aspect: number, near: number, far: number): Mat4 {
    const out = new Float32Array(16);
    mat4PerspectiveLHToRef(out, fov, aspect, near, far);
    return out as unknown as Mat4;
}
