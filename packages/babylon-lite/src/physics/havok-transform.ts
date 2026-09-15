import type { SceneNode } from "../scene/scene-node.js";

function rotationFromMatrix(m: ArrayLike<number>, qx: number, qy: number, qz: number, qw: number) {
    let ix = Math.hypot(m[0]!, m[1]!, m[2]!);
    let iy = Math.hypot(m[4]!, m[5]!, m[6]!);
    let iz = Math.hypot(m[8]!, m[9]!, m[10]!);
    ix = ix > 1e-8 ? 1 / ix : 0;
    iy = iy > 1e-8 ? 1 / iy : 0;
    iz = iz > 1e-8 ? 1 / iz : 0;
    if (m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) + m[1]! * (m[6]! * m[8]! - m[4]! * m[10]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!) < 0) {
        iy = -iy;
    }
    const m0 = m[0]! * ix;
    const m1 = m[1]! * ix;
    const m2 = m[2]! * ix;
    const m4 = m[4]! * iy;
    const m5 = m[5]! * iy;
    const m6 = m[6]! * iy;
    const m8 = m[8]! * iz;
    const m9 = m[9]! * iz;
    const m10 = m[10]! * iz;
    const trace = m0 + m5 + m10;
    let x: number, y: number, z: number, w: number, s: number;
    if (trace > 0) {
        s = 0.5 / Math.sqrt(trace + 1);
        x = (m6 - m9) * s;
        y = (m8 - m2) * s;
        z = (m1 - m4) * s;
        w = 0.25 / s;
    } else if (m0 > m5 && m0 > m10) {
        s = 2 * Math.sqrt(1 + m0 - m5 - m10);
        x = 0.25 * s;
        y = (m4 + m1) / s;
        z = (m8 + m2) / s;
        w = (m6 - m9) / s;
    } else if (m5 > m10) {
        s = 2 * Math.sqrt(1 + m5 - m0 - m10);
        x = (m4 + m1) / s;
        y = 0.25 * s;
        z = (m9 + m6) / s;
        w = (m8 - m2) / s;
    } else {
        s = 2 * Math.sqrt(1 + m10 - m0 - m5);
        x = (m8 + m2) / s;
        y = (m9 + m6) / s;
        z = 0.25 * s;
        w = (m1 - m4) / s;
    }
    const invLength = 1 / Math.hypot(x, y, z, w);
    x *= invLength;
    y *= invLength;
    z *= invLength;
    w *= invLength;
    return {
        x: w * qx + x * qw + y * qz - z * qy,
        y: w * qy + y * qw + z * qx - x * qz,
        z: w * qz + z * qw + x * qy - y * qx,
        w: w * qw - x * qx - y * qy - z * qz,
    };
}

export function nodeToHavokTransform(node: SceneNode): [[number, number, number], [number, number, number, number]] {
    const q = node.rotationQuaternion;
    const p = node.position;
    if (node.parent) {
        const wm = node.parent.worldMatrix;
        const r = rotationFromMatrix(wm, q.x, q.y, q.z, q.w);
        return [
            [wm[12]! + p.x, wm[13]! + p.y, wm[14]! + p.z],
            [r.x, r.y, r.z, r.w],
        ];
    } else {
        return [
            [p.x, p.y, p.z],
            [q.x, q.y, q.z, q.w],
        ];
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
        const iwm = [i0, i1, i2, 0, i4, i5, i6, 0, i8, i9, i10];
        const r = rotationFromMatrix(iwm, rot[0], rot[1], rot[2], rot[3]);
        node.position.set(
            pos[0] * i0 + pos[1] * i4 + pos[2] * i8 - wm[12]! * i0 - wm[13]! * i4 - wm[14]! * i8,
            pos[0] * i1 + pos[1] * i5 + pos[2] * i9 - wm[12]! * i1 - wm[13]! * i5 - wm[14]! * i9,
            pos[0] * i2 + pos[1] * i6 + pos[2] * i10 - wm[12]! * i2 - wm[13]! * i6 - wm[14]! * i10
        );
        node.rotationQuaternion.set(r.x, r.y, r.z, r.w);
    } else {
        node.position.set(pos[0], pos[1], pos[2]);
        node.rotationQuaternion.set(rot[0], rot[1], rot[2], rot[3]);
    }
}
