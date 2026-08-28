/**
 * Antigravity Racer — Babylon.js Euler convention.
 *
 * The source playground authored the boulder transforms (and the ship's model
 * yaw) as Babylon.js `mesh.rotation` triples, which Babylon applies in
 * yaw-pitch-roll (y-x-z) order via `Quaternion.RotationYawPitchRoll`. Lite's own
 * Euler proxy uses intrinsic XYZ, so converting here — and feeding the result in
 * as a quaternion — is what keeps the ported placements bit-for-bit faithful.
 */

import type { Quat } from "babylon-lite";

/** Babylon.js Euler triple (applied yaw-pitch-roll / y-x-z) → quaternion. */
export function bjsEulerToQuat(rx: number, ry: number, rz: number): Quat {
    const sx = Math.sin(rx * 0.5);
    const cx = Math.cos(rx * 0.5);
    const sy = Math.sin(ry * 0.5);
    const cy = Math.cos(ry * 0.5);
    const sz = Math.sin(rz * 0.5);
    const cz = Math.cos(rz * 0.5);
    return {
        x: cy * sx * cz + sy * cx * sz,
        y: sy * cx * cz - cy * sx * sz,
        z: cy * cx * sz - sy * sx * cz,
        w: cy * cx * cz + sy * sx * sz,
    };
}

/** Same as {@link bjsEulerToQuat} but writes into an existing quaternion object. */
export function bjsEulerToQuatInto(rx: number, ry: number, rz: number, out: Quat): Quat {
    const sx = Math.sin(rx * 0.5);
    const cx = Math.cos(rx * 0.5);
    const sy = Math.sin(ry * 0.5);
    const cy = Math.cos(ry * 0.5);
    const sz = Math.sin(rz * 0.5);
    const cz = Math.cos(rz * 0.5);
    out.x = cy * sx * cz + sy * cx * sz;
    out.y = sy * cx * cz - cy * sx * sz;
    out.z = cy * cx * sz - sy * sx * cz;
    out.w = cy * cx * cz + sy * sx * sz;
    return out;
}
