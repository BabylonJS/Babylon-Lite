/** Build a unit quaternion from a right-handed look direction.
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Vec3, Quat } from "./types.js";
import { _quatFromRotationBasis } from "./quat-from-rotation-matrix.js";

/**
 * Build a unit quaternion that orients local +Z onto `forward` and local +Y onto
 * `up`, using a right-handed basis (`right = up × forward`). Matches Babylon.js
 * `Quaternion.FromLookDirectionRH`.
 * @param forward - Desired forward direction (should be normalized).
 * @param up - Desired up direction (should be normalized and not parallel to `forward`).
 * @returns A new `{ x, y, z, w }` quaternion.
 */
export function quatFromLookDirectionRH(forward: Vec3, up: Vec3): Quat {
    // right = up × forward. Rotation matrix columns are (right, up, forward).
    const rx = up.y * forward.z - up.z * forward.y;
    const ry = up.z * forward.x - up.x * forward.z;
    const rz = up.x * forward.y - up.y * forward.x;
    return _quatFromRotationBasis(rx, up.x, forward.x, ry, up.y, forward.y, rz, up.z, forward.z);
}
