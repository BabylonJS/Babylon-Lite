import type { Vec3 } from "./types.js";

/** Write Vec3 into a Float32Array at the given byte offset (for uniform buffers). */
export function writeVec3(out: Float32Array, offset: number, v: Vec3): void {
    out[offset] = v.x;
    out[offset + 1] = v.y;
    out[offset + 2] = v.z;
}
