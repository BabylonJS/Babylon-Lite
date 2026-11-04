import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";
import { composeMat4IntoBuffer } from "./compose-mat4-into-buffer.js";
import { allocateMat4 } from "./_matrix-allocator.js";

/** Compose TRS (translation * rotation * scale) into a single Mat4. */
export function composeMat4(tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): Mat4 {
    const out: Mat4Storage = allocateMat4() as unknown as Mat4Storage;
    composeMat4IntoBuffer(out, 0, tx, ty, tz, qx, qy, qz, qw, sx, sy, sz);
    return out as unknown as Mat4;
}
