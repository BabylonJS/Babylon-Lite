/** Decompose a column-major 4×4 affine matrix into translation, rotation, and scale.
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Mat4, Quat, Vec3 } from "./types.js";
import { _quatFromRotationBasis } from "./create-quat-from-rotation-mat4.js";
import { mat4Determinant3 } from "./mat4-determinant3.js";

/** Result of {@link decomposeMat4}: a TRS triple. */
export interface DecomposedTransform {
    /** Translation (matrix columns 12/13/14). */
    translation: Vec3;
    /** Rotation as a unit quaternion. */
    rotation: Quat;
    /** Per-axis scale (lengths of the basis columns). */
    scale: Vec3;
}

/** @internal Decompose into caller-owned objects for allocation-sensitive animation paths. */
export function _decomposeMat4Into(m: ArrayLike<number>, translation: Vec3, rotation: Quat, scale: Vec3): void {
    const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
    const syAbs = Math.hypot(m[4]!, m[5]!, m[6]!);
    const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
    const sy = mat4Determinant3(m) < 0 ? -syAbs : syAbs;
    const invSx = sx > 1e-8 ? 1 / sx : 0;
    const invSy = syAbs > 1e-8 ? 1 / sy : 0;
    const invSz = sz > 1e-8 ? 1 / sz : 0;
    const q = _quatFromRotationBasis(m[0]! * invSx, m[4]! * invSy, m[8]! * invSz, m[1]! * invSx, m[5]! * invSy, m[9]! * invSz, m[2]! * invSx, m[6]! * invSy, m[10]! * invSz);
    const invLen = 1 / Math.hypot(q.x, q.y, q.z, q.w);
    translation.x = m[12]!;
    translation.y = m[13]!;
    translation.z = m[14]!;
    rotation.x = q.x * invLen;
    rotation.y = q.y * invLen;
    rotation.z = q.z * invLen;
    rotation.w = q.w * invLen;
    scale.x = sx;
    scale.y = sy;
    scale.z = sz;
}

/**
 * Decompose a column-major 4×4 affine matrix into translation, rotation (unit
 * quaternion), and scale. Assumes a shear-free TRS matrix.
 *
 * **Behaviour change:** earlier versions documented and returned an always
 * non-negative `scale`, silently dropping the reflection carried by a mirrored
 * (negative determinant) matrix. `scale.y` is now negative for such a matrix.
 * Callers that assumed non-negative components — for example feeding `scale`
 * straight into a size or extent — must take `Math.abs` themselves; callers that
 * recompose the TRS get the correct mirrored transform back instead of an
 * un-mirrored one.
 *
 * Mirror image matrices are preserved by folding the reflection into a negative
 * Y scale, matching Babylon.js `Matrix.decompose`. The decomposition is therefore
 * lossless — recomposing the returned TRS reproduces the original matrix — but it
 * is *canonical*, not sign-faithful: a matrix built from a negative X or Z scale
 * decomposes to a negative Y scale plus a different rotation.
 *
 * A degenerate axis (scale magnitude below 1e-8) is tolerated rather than
 * rejected: its basis column is treated as zero, so the returned rotation stays
 * finite but is no longer meaningful for that axis, and the result no longer
 * recomposes to the original matrix.
 * @param m - Column-major 4×4 matrix.
 * @returns A new translation/rotation/scale triple.
 */
export function decomposeMat4(m: Mat4): DecomposedTransform {
    const result: DecomposedTransform = {
        translation: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
    };
    _decomposeMat4Into(m, result.translation, result.rotation, result.scale);
    return result;
}
