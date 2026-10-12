import type { Mat4 } from "./types.js";
import { writePerspectiveMat4LHIntoBuffer } from "./write-perspective-mat4-lh-into-buffer.js";
import { allocateMat4 } from "./_matrix-allocator.js";
import type { Mat4Storage } from "./types.js";

/** Reverse-Z perspective projection (left-handed, zero-to-one depth). */
export function createPerspectiveMat4LH(fov: number, aspect: number, near: number, far: number): Mat4 {
    const out = allocateMat4() as unknown as Mat4Storage;
    writePerspectiveMat4LHIntoBuffer(out, fov, aspect, near, far);
    return out as unknown as Mat4;
}
