/** Decompose a column-major 4×4 affine matrix into translation, rotation, and scale.
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Mat4, Quat, Vec3 } from "./types.js";
import { _quatFromRotationBasis } from "./quat-from-rotation-matrix.js";

/** Result of {@link mat4Decompose}: a TRS triple. */
export interface DecomposedTransform {
    /** Translation (matrix columns 12/13/14). */
    translation: Vec3;
    /** Rotation as a unit quaternion. */
    rotation: Quat;
    /** Per-axis scale (lengths of the basis columns). */
    scale: Vec3;
}

/**
 * Decompose a column-major 4×4 affine matrix into translation, rotation (unit
 * quaternion), and scale. Assumes a TRS matrix (no shear). Mirror image (negative
 * determinant) matrices are not specially handled — the returned scale is always
 * non-negative, matching the rest of the engine's decompose usage.
 * @param m - Column-major 4×4 matrix.
 * @returns A new translation/rotation/scale triple.
 */
export function mat4Decompose(m: Mat4): DecomposedTransform {
    const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
    const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
    const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
    const invSx = sx > 1e-8 ? 1 / sx : 0;
    const invSy = sy > 1e-8 ? 1 / sy : 0;
    const invSz = sz > 1e-8 ? 1 / sz : 0;
    // Strip scale from the basis columns, then extract the rotation quaternion.
    const q = _quatFromRotationBasis(m[0]! * invSx, m[4]! * invSy, m[8]! * invSz, m[1]! * invSx, m[5]! * invSy, m[9]! * invSz, m[2]! * invSx, m[6]! * invSy, m[10]! * invSz);
    // Renormalize — dividing by per-axis scale introduces small drift.
    const invLen = 1 / Math.hypot(q.x, q.y, q.z, q.w);
    return {
        translation: { x: m[12]!, y: m[13]!, z: m[14]! },
        rotation: { x: q.x * invLen, y: q.y * invLen, z: q.z * invLen, w: q.w * invLen },
        scale: { x: sx, y: sy, z: sz },
    };
}
