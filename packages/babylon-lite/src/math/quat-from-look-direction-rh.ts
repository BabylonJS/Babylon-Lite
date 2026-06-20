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
    // Orthonormalize the basis so the result is a pure rotation even if the inputs
    // are non-unit or slightly non-orthogonal. For valid (unit, orthogonal) inputs
    // this is a no-op and matches Babylon.js exactly.
    let fx = forward.x,
        fy = forward.y,
        fz = forward.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    // right = up × forward (normalized)
    let rx = up.y * fz - up.z * fy;
    let ry = up.z * fx - up.x * fz;
    let rz = up.x * fy - up.y * fx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;
    // up = forward × right (orthonormal by construction). Matrix columns are (right, up, forward).
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;
    return _quatFromRotationBasis(rx, ux, fx, ry, uy, fy, rz, uz, fz);
}
