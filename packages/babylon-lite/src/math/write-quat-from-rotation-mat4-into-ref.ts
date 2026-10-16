import { _quatFromRotationBasis } from "./create-quat-from-rotation-mat4.js";
import type { Mat4, Quat } from "./types.js";

/**
 * Write a unit quaternion from the rotation part of a column-major 4x4 matrix
 * into caller-owned storage.
 */
export function writeQuatFromRotationMat4IntoRef<T extends Quat>(matrix: Mat4, out: T): T {
    _quatFromRotationBasis(matrix[0]!, matrix[4]!, matrix[8]!, matrix[1]!, matrix[5]!, matrix[9]!, matrix[2]!, matrix[6]!, matrix[10]!, out);
    return out;
}
