interface XrPoseTarget {
    position: { set(x: number, y: number, z: number): void };
    rotationQuaternion: { set(x: number, y: number, z: number, w: number): void };
}

/** @internal Convert a WebXR right-handed rigid matrix to Lite's left-handed space. */
export function copyXrRigidMatrixToLeftHanded(out: Mat4Storage, source: ArrayLike<number>): void {
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

/** @internal Convert a WebXR projection so it consumes left-handed view coordinates. */
export function copyXrProjectionToLeftHanded(out: Mat4Storage, source: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) {
        out[i] = source[i]!;
    }
    out[8] = -out[8]!;
    out[9] = -out[9]!;
    out[10] = -out[10]!;
    out[11] = -out[11]!;
}

/** @internal Apply a WebXR pose to a left-handed scene node without allocating. */
export function setXrPoseToLeftHanded(target: XrPoseTarget, transform: XRRigidTransform): void {
    const p = transform.position;
    const o = transform.orientation;
    target.position.set(p.x, p.y, -p.z);
    target.rotationQuaternion.set(o.x, o.y, -o.z, -o.w);
}
import type { Mat4Storage } from "../math/types.js";
