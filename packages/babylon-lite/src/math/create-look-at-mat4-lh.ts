import type { Mat4, Vec3 } from "./types.js";
import { writeLookAtMat4LHIntoBuffer } from "./write-look-at-mat4-lh-into-buffer.js";
import { allocateMat4Storage } from "./_matrix-allocator.js";

/** LookAt matrix (right-handed). Matches Babylon.js Matrix.LookAtLHToRef with LH convention. */
export function createLookAtMat4LH(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const out = allocateMat4Storage();
    writeLookAtMat4LHIntoBuffer(out, eye, target, up);
    return out as unknown as Mat4;
}
