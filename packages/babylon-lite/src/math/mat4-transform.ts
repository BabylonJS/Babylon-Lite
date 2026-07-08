import type { Mat4, Mat4Storage, Vec3 } from "./types.js";

/**
 * Transform the point `(x, y, z)` by the column-major 4x4 matrix `m` (including the perspective divide),
 * writing the world-space result into `out`. Mirrors Babylon.js `Vector3.TransformCoordinatesFromFloatsToRef`.
 */
export function transformCoordinatesToRef(x: number, y: number, z: number, m: Mat4, out: Vec3): void {
    const s = m as unknown as Mat4Storage;
    const rx = x * s[0]! + y * s[4]! + z * s[8]! + s[12]!;
    const ry = x * s[1]! + y * s[5]! + z * s[9]! + s[13]!;
    const rz = x * s[2]! + y * s[6]! + z * s[10]! + s[14]!;
    const rw = 1 / (x * s[3]! + y * s[7]! + z * s[11]! + s[15]!);
    out.x = rx * rw;
    out.y = ry * rw;
    out.z = rz * rw;
}

/**
 * Transform the direction `(x, y, z)` by the upper 3x3 (rotation/scale, no translation) of the
 * column-major matrix `m`, writing the result into `out`. Mirrors Babylon.js
 * `Vector3.TransformNormalFromFloatsToRef`.
 */
export function transformNormalToRef(x: number, y: number, z: number, m: Mat4, out: Vec3): void {
    const s = m as unknown as Mat4Storage;
    out.x = x * s[0]! + y * s[4]! + z * s[8]!;
    out.y = x * s[1]! + y * s[5]! + z * s[9]!;
    out.z = x * s[2]! + y * s[6]! + z * s[10]!;
}

/** Read the translation component (column 3) of the column-major matrix `m` into `out`. */
export function mat4GetTranslationToRef(m: Mat4, out: Vec3): void {
    const s = m as unknown as Mat4Storage;
    out.x = s[12]!;
    out.y = s[13]!;
    out.z = s[14]!;
}
