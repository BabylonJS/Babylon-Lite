/** Build a unit quaternion from the rotation part of a 4×4 matrix.
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Mat4, Quat } from "./types.js";

/** Build a unit quaternion from a 3×3 rotation basis (column-major element names:
 *  m11/m21/m31 = column 0, m12/m22/m32 = column 1, m13/m23/m33 = column 2). Uses
 *  Shepperd's trace method, byte-for-byte matching Babylon.js
 *  `Quaternion.FromRotationMatrix`.
 *  @internal */
export function _quatFromRotationBasis(m11: number, m12: number, m13: number, m21: number, m22: number, m23: number, m31: number, m32: number, m33: number): Quat {
    const trace = m11 + m22 + m33;
    let s: number;
    if (trace > 0) {
        s = 0.5 / Math.sqrt(trace + 1.0);
        return { x: (m32 - m23) * s, y: (m13 - m31) * s, z: (m21 - m12) * s, w: 0.25 / s };
    }
    if (m11 > m22 && m11 > m33) {
        s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
        return { x: 0.25 * s, y: (m12 + m21) / s, z: (m13 + m31) / s, w: (m32 - m23) / s };
    }
    if (m22 > m33) {
        s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
        return { x: (m12 + m21) / s, y: 0.25 * s, z: (m23 + m32) / s, w: (m13 - m31) / s };
    }
    s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    return { x: (m13 + m31) / s, y: (m23 + m32) / s, z: 0.25 * s, w: (m21 - m12) / s };
}

/**
 * Build a unit quaternion from the rotation part of a column-major 4×4 matrix,
 * matching Babylon.js `Quaternion.FromRotationMatrix`. The matrix's upper-left
 * 3×3 must be a pure rotation (orthonormal, no scale).
 * @param matrix - Column-major 4×4 rotation matrix.
 * @returns A new `{ x, y, z, w }` quaternion.
 */
export function quatFromRotationMatrix(matrix: Mat4): Quat {
    return _quatFromRotationBasis(matrix[0]!, matrix[4]!, matrix[8]!, matrix[1]!, matrix[5]!, matrix[9]!, matrix[2]!, matrix[6]!, matrix[10]!);
}
