import type { Mat4, Vec3 } from "./types.js";
import { mat4LookAtLHToRef } from "./mat4-look-at-lh-to-ref.js";
import { allocateMat4Storage } from "./_matrix-allocator.js";

/** LookAt matrix (right-handed). Matches Babylon.js Matrix.LookAtLHToRef with LH convention. */
export function mat4LookAtLH(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const out = allocateMat4Storage();
    mat4LookAtLHToRef(out, eye, target, up);
    return out as unknown as Mat4;
}
