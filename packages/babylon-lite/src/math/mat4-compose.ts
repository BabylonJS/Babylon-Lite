import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";
import { mat4ComposeInto } from "./mat4-compose-into.js";

/** Compose TRS (translation * rotation * scale) into a single Mat4. */
export function mat4Compose(tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): Mat4 {
    const out: Mat4Storage = new Float32Array(16);
    mat4ComposeInto(out, 0, tx, ty, tz, qx, qy, qz, qw, sx, sy, sz);
    return out as unknown as Mat4;
}
