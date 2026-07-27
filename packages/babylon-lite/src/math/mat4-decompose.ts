/** Decompose a column-major 4×4 affine matrix into translation, rotation, and scale.
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Mat4, Quat, Vec3 } from "./types.js";
import { _quatFromRotationBasis } from "./quat-from-rotation-matrix.js";
import { mat4Determinant3 } from "./mat4-determinant3.js";

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
 * quaternion), and scale. Assumes a shear-free TRS matrix.
 *
 * Mirror image (negative determinant) matrices are preserved: the reflection is
 * folded into a negative Y scale, matching Babylon.js `Matrix.decompose`. The
 * decomposition is therefore lossless — recomposing the returned TRS reproduces
 * the original matrix — but it is *canonical*, not sign-faithful: a matrix built
 * from a negative X or Z scale decomposes to a negative Y scale plus a different
 * rotation.
 *
 * A degenerate axis (scale magnitude below 1e-8) is tolerated rather than
 * rejected: its basis column is treated as zero, so the returned rotation stays
 * finite but is no longer meaningful for that axis, and the result no longer
 * recomposes to the original matrix.
 * @param m - Column-major 4×4 matrix.
 * @returns A new translation/rotation/scale triple.
 */
export function mat4Decompose(m: Mat4): DecomposedTransform {
    const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
    const syAbs = Math.hypot(m[4]!, m[5]!, m[6]!);
    const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
    // A negative determinant means the basis is mirrored; carrying that sign on one axis keeps the
    // remaining basis a proper rotation, so the quaternion extraction below stays valid and the
    // reflection survives recomposition.
    const sy = mat4Determinant3(m) < 0 ? -syAbs : syAbs;
    const invSx = sx > 1e-8 ? 1 / sx : 0;
    // Guard on the magnitude, divide by the signed scale — otherwise a mirrored basis would
    // fail the epsilon test and zero out the Y column.
    const invSy = syAbs > 1e-8 ? 1 / sy : 0;
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
