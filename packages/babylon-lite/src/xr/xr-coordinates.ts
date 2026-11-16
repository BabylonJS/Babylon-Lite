import { _rightHanded } from "#coordinate-system";
import type { Mat4Storage } from "../math/types.js";

interface XrPoseTarget {
    position: { set(x: number, y: number, z: number): void };
    rotationQuaternion: { set(x: number, y: number, z: number, w: number): void };
}

/** @internal Copy a WebXR rigid matrix into Lite's world: mirrored into the left-handed world by default,
 *  verbatim in a right-handed build, whose world is WebXR's own. */
export function copyXrRigidMatrixToWorld(out: Mat4Storage, source: ArrayLike<number>): void {
    if (_rightHanded !== null) {
        for (let i = 0; i < 16; i++) {
            out[i] = source[i]!;
        }
        return;
    }
    out[0] = source[0]!;
    out[1] = source[1]!;
    out[2] = -source[2]!;
    out[3] = source[3]!;
    out[4] = source[4]!;
    out[5] = source[5]!;
    out[6] = -source[6]!;
    out[7] = source[7]!;
    out[8] = -source[8]!;
    out[9] = -source[9]!;
    out[10] = source[10]!;
    out[11] = -source[11]!;
    out[12] = source[12]!;
    out[13] = source[13]!;
    out[14] = -source[14]!;
    out[15] = source[15]!;
}

/** @internal Convert a WebXR projection so it consumes left-handed view coordinates. Lite's view space is
 *  left-handed in both builds (a right-handed camera's view matrix is `Sz·V_RH`), so this holds for both. */
export function copyXrProjectionToLeftHanded(out: Mat4Storage, source: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) {
        out[i] = source[i]!;
    }
    out[8] = -out[8]!;
    out[9] = -out[9]!;
    out[10] = -out[10]!;
    out[11] = -out[11]!;
}

/** @internal Apply a WebXR pose to a scene node in Lite's world without allocating (mirrored into the
 *  left-handed world by default, verbatim in a right-handed build). */
export function setXrPoseToWorld(target: XrPoseTarget, transform: XRRigidTransform): void {
    const p = transform.position;
    const o = transform.orientation;
    target.position.set(p.x, p.y, _rightHanded ? p.z : -p.z);
    target.rotationQuaternion.set(o.x, o.y, _rightHanded ? o.z : -o.z, _rightHanded ? o.w : -o.w);
}
