import type { Mat4Storage } from "./types.js";

/** Compose TRS directly into a Mat4 storage view at offset (zero allocation).
 *  Storage may be F32- or F64-backed. */
export function mat4ComposeInto(
    dst: Mat4Storage,
    off: number,
    tx: number,
    ty: number,
    tz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    sx: number,
    sy: number,
    sz: number
): void {
    const xx = qx * qx,
        yy = qy * qy,
        zz = qz * qz;
    const xy = qx * qy,
        xz = qx * qz,
        yz = qy * qz;
    const wx = qw * qx,
        wy = qw * qy,
        wz = qw * qz;
    dst[off] = (1 - 2 * (yy + zz)) * sx;
    dst[off + 1] = 2 * (xy + wz) * sx;
    dst[off + 2] = 2 * (xz - wy) * sx;
    dst[off + 3] = 0;
    dst[off + 4] = 2 * (xy - wz) * sy;
    dst[off + 5] = (1 - 2 * (xx + zz)) * sy;
    dst[off + 6] = 2 * (yz + wx) * sy;
    dst[off + 7] = 0;
    dst[off + 8] = 2 * (xz + wy) * sz;
    dst[off + 9] = 2 * (yz - wx) * sz;
    dst[off + 10] = (1 - 2 * (xx + yy)) * sz;
    dst[off + 11] = 0;
    dst[off + 12] = tx;
    dst[off + 13] = ty;
    dst[off + 14] = tz;
    dst[off + 15] = 1;
}
