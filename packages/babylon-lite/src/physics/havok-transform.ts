import type { Mat4Storage } from "../math/types.js";
import { composeMat4IntoBuffer } from "../math/compose-mat4-into-buffer.js";
import { _quatFromRotationBasis } from "../math/create-quat-from-rotation-mat4.js";
import type { SceneNode } from "../scene/scene-node.js";
import { _markWorldMatrixDirty } from "../scene/world-matrix-state.js";

/**
 * Extract the rotation from a possibly scaled affine matrix and pre-multiply it
 * with the supplied quaternion: `result = matrixRotation * quaternion`.
 *
 * Unlike `_quatFromRotationBasis`, this accepts a scaled or mirrored basis. It
 * removes per-axis scale, folds a negative determinant into the Y axis to keep
 * a proper rotation basis, normalizes the extracted quaternion, and performs
 * the final quaternion composition required by the Havok transform conversion.
 */
function composeMatrixRotation(m: ArrayLike<number>, qx: number, qy: number, qz: number, qw: number) {
    let ix = Math.hypot(m[0]!, m[1]!, m[2]!);
    let iy = Math.hypot(m[4]!, m[5]!, m[6]!);
    let iz = Math.hypot(m[8]!, m[9]!, m[10]!);
    ix = ix > 1e-8 ? 1 / ix : 0;
    iy = iy > 1e-8 ? 1 / iy : 0;
    iz = iz > 1e-8 ? 1 / iz : 0;
    if (m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) + m[1]! * (m[6]! * m[8]! - m[4]! * m[10]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!) < 0) {
        iy = -iy;
        qx = -qx;
        qz = -qz;
    }
    const r = _quatFromRotationBasis(m[0]! * ix, m[4]! * iy, m[8]! * iz, m[1]! * ix, m[5]! * iy, m[9]! * iz, m[2]! * ix, m[6]! * iy, m[10]! * iz);
    const invLength = 1 / Math.hypot(r.x, r.y, r.z, r.w);
    const x = r.x * invLength;
    const y = r.y * invLength;
    const z = r.z * invLength;
    const w = r.w * invLength;
    return {
        x: w * qx + x * qw + y * qz - z * qy,
        y: w * qy + y * qw + z * qx - x * qz,
        z: w * qz + z * qw + x * qy - y * qx,
        w: w * qw - x * qx - y * qy - z * qz,
    };
}

export function nodeToHavokTransform(node: SceneNode): [[number, number, number], [number, number, number, number]] {
    let { x: qx, y: qy, z: qz, w: qw } = node.rotationQuaternion;
    let { x: px, y: py, z: pz } = node.position;
    if (node._localMatrix) {
        const m = node._localMatrix;
        px = m[12]!;
        py = m[13]!;
        pz = m[14]!;
        ({ x: qx, y: qy, z: qz, w: qw } = composeMatrixRotation(m, 0, 0, 0, 1));
    }

    if (node.parent) {
        const wm = node.parent.worldMatrix;
        const r = composeMatrixRotation(wm, qx, qy, qz, qw);
        return [
            [px * wm[0]! + py * wm[4]! + pz * wm[8]! + wm[12]!, px * wm[1]! + py * wm[5]! + pz * wm[9]! + wm[13]!, px * wm[2]! + py * wm[6]! + pz * wm[10]! + wm[14]!],
            [r.x, r.y, r.z, r.w],
        ];
    } else {
        return [
            [px, py, pz],
            [qx, qy, qz, qw],
        ];
    }
}

function applyLocalTransform(node: SceneNode, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): void {
    const m = node._localMatrix;
    if (m) {
        const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
        let sy = Math.hypot(m[4]!, m[5]!, m[6]!);
        const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
        if (m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) + m[1]! * (m[6]! * m[8]! - m[4]! * m[10]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!) < 0) {
            sy = -sy;
        }
        composeMat4IntoBuffer(m as unknown as Mat4Storage, 0, px, py, pz, qx, qy, qz, qw, sx, sy, sz);
        _markWorldMatrixDirty(node);
    } else {
        node.position.set(px, py, pz);
        node.rotationQuaternion.set(qx, qy, qz, qw);
    }
}

export function havokTransformToNode(transform: readonly [readonly [number, number, number], readonly [number, number, number, number]], node: SceneNode): void {
    const pos = transform[0]; // [x, y, z]
    const rot = transform[1]; // [x, y, z, w]
    if (node.parent) {
        const wm = node.parent.worldMatrix;
        const c0 = wm[5]! * wm[10]! - wm[6]! * wm[9]!;
        const c1 = wm[2]! * wm[9]! - wm[1]! * wm[10]!;
        const c2 = wm[1]! * wm[6]! - wm[2]! * wm[5]!;
        let invDet = wm[0]! * c0 + wm[4]! * c1 + wm[8]! * c2;
        if (Math.abs(invDet) < 1e-10) {
            return; // singular world matrix, skip sync
        }
        invDet = 1 / invDet;
        const i0 = c0 * invDet;
        const i1 = c1 * invDet;
        const i2 = c2 * invDet;
        const i4 = (wm[6]! * wm[8]! - wm[4]! * wm[10]!) * invDet;
        const i5 = (wm[0]! * wm[10]! - wm[2]! * wm[8]!) * invDet;
        const i6 = (wm[2]! * wm[4]! - wm[0]! * wm[6]!) * invDet;
        const i8 = (wm[4]! * wm[9]! - wm[5]! * wm[8]!) * invDet;
        const i9 = (wm[1]! * wm[8]! - wm[0]! * wm[9]!) * invDet;
        const i10 = (wm[0]! * wm[5]! - wm[1]! * wm[4]!) * invDet;
        // Decompose the complete inverse-parent × desired-world basis; the inverse basis alone is sheared by a rotated parent's non-uniform scale.
        const qx = rot[0];
        const qy = rot[1];
        const qz = rot[2];
        const qw = rot[3];
        const xx = qx * qx;
        const yy = qy * qy;
        const zz = qz * qz;
        const xy = qx * qy;
        const xz = qx * qz;
        const yz = qy * qz;
        const wx = qw * qx;
        const wy = qw * qy;
        const wz = qw * qz;
        const w0 = 1 - 2 * (yy + zz);
        const w1 = 2 * (xy + wz);
        const w2 = 2 * (xz - wy);
        const w4 = 2 * (xy - wz);
        const w5 = 1 - 2 * (xx + zz);
        const w6 = 2 * (yz + wx);
        const w8 = 2 * (xz + wy);
        const w9 = 2 * (yz - wx);
        const w10 = 1 - 2 * (xx + yy);
        const local = [
            i0 * w0 + i4 * w1 + i8 * w2,
            i1 * w0 + i5 * w1 + i9 * w2,
            i2 * w0 + i6 * w1 + i10 * w2,
            0,
            i0 * w4 + i4 * w5 + i8 * w6,
            i1 * w4 + i5 * w5 + i9 * w6,
            i2 * w4 + i6 * w5 + i10 * w6,
            0,
            i0 * w8 + i4 * w9 + i8 * w10,
            i1 * w8 + i5 * w9 + i9 * w10,
            i2 * w8 + i6 * w9 + i10 * w10,
        ];
        const r = composeMatrixRotation(local, 0, 0, 0, 1);
        applyLocalTransform(
            node,
            pos[0] * i0 + pos[1] * i4 + pos[2] * i8 - wm[12]! * i0 - wm[13]! * i4 - wm[14]! * i8,
            pos[0] * i1 + pos[1] * i5 + pos[2] * i9 - wm[12]! * i1 - wm[13]! * i5 - wm[14]! * i9,
            pos[0] * i2 + pos[1] * i6 + pos[2] * i10 - wm[12]! * i2 - wm[13]! * i6 - wm[14]! * i10,
            r.x,
            r.y,
            r.z,
            r.w
        );
    } else {
        applyLocalTransform(node, pos[0], pos[1], pos[2], rot[0], rot[1], rot[2], rot[3]);
    }
}
