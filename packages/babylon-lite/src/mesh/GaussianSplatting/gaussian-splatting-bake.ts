import type { GaussianSplattingMesh } from "./gaussian-splatting-mesh.js";
import type { Mat4 } from "../../math/types.js";

const ROW_LENGTH = 32;

function mat4TransformCoord(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
    const w = 1.0 / (m[3]! * x + m[7]! * y + m[11]! * z + m[15]!);
    return [(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * w, (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * w, (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * w];
}

function mat4ToRotationQuat(m: Float32Array): [number, number, number, number] {
    const sx = Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!);
    const sy = Math.sqrt(m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!);
    const sz = Math.sqrt(m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!);
    const r00 = m[0]! / sx,
        r01 = m[1]! / sx,
        r02 = m[2]! / sx;
    const r10 = m[4]! / sy,
        r11 = m[5]! / sy,
        r12 = m[6]! / sy;
    const r20 = m[8]! / sz,
        r21 = m[9]! / sz,
        r22 = m[10]! / sz;

    const trace = r00 + r11 + r22;
    let qw: number, qx: number, qy: number, qz: number;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        qw = 0.25 / s;
        qx = (r12 - r21) * s;
        qy = (r20 - r02) * s;
        qz = (r01 - r10) * s;
    } else if (r00 > r11 && r00 > r22) {
        const s = 2.0 * Math.sqrt(1.0 + r00 - r11 - r22);
        qw = (r12 - r21) / s;
        qx = 0.25 * s;
        qy = (r01 + r10) / s;
        qz = (r02 + r20) / s;
    } else if (r11 > r22) {
        const s = 2.0 * Math.sqrt(1.0 + r11 - r00 - r22);
        qw = (r20 - r02) / s;
        qx = (r01 + r10) / s;
        qy = 0.25 * s;
        qz = (r12 + r21) / s;
    } else {
        const s = 2.0 * Math.sqrt(1.0 + r22 - r00 - r11);
        qw = (r01 - r10) / s;
        qx = (r02 + r20) / s;
        qy = (r12 + r21) / s;
        qz = 0.25 * s;
    }
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    return [qx / len, qy / len, qz / len, qw / len];
}

function quatMultiply(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): [number, number, number, number] {
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/**
 * Bakes a transform matrix directly into a mesh's splat vertices, rewriting each splat's
 * position, scale, and orientation so the mesh renders identically with an identity transform.
 * @param mesh - Gaussian Splatting mesh to modify in place.
 * @param transform - World-space transform to bake into the splat data.
 */
export function bakeTransformIntoVertices(mesh: GaussianSplattingMesh, transform: Mat4): void {
    const arrayBuffer = mesh.splatsData;
    const newBuffer = arrayBuffer.slice(0);
    const u8 = new Uint8Array(newBuffer);
    const f32 = new Float32Array(newBuffer);
    const splatCount = (u8.byteLength / ROW_LENGTH) | 0;

    const m = new Float32Array(transform as unknown as ArrayLike<number>);

    const scaleX = Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!);

    const [tqx, tqy, tqz, tqw] = mat4ToRotationQuat(m);

    for (let i = 0; i < splatCount; i++) {
        const fi = i * 8;
        const bi = i * ROW_LENGTH;

        const rawX = f32[fi]!;
        const rawY = f32[fi + 1]!;
        const rawZ = f32[fi + 2]!;

        const x = rawX;
        const y = -rawY;
        const z = rawZ;

        const [tx, ty, tz] = mat4TransformCoord(m, x, y, z);
        f32[fi] = tx;
        f32[fi + 1] = -ty;
        f32[fi + 2] = tz;

        f32[fi + 3] = f32[fi + 3]! * scaleX;
        f32[fi + 4] = f32[fi + 4]! * scaleX;
        f32[fi + 5] = f32[fi + 5]! * scaleX;

        let qx = (u8[bi + 29]! - 127.5) / 127.5;
        let qy = (u8[bi + 30]! - 127.5) / 127.5;
        let qz = (u8[bi + 31]! - 127.5) / 127.5;
        let qw = (u8[bi + 28]! - 127.5) / 127.5;
        const qLen = Math.hypot(qx, qy, qz, qw) || 1;
        qx /= qLen;
        qy /= qLen;
        qz /= qLen;
        qw /= qLen;

        // Lite's buildSplatGeometry decodes quaternions with W,Y sign flips
        // (to compensate for the Y-position negate). The transform quaternion
        // must be conjugated by diag(1,-1,1) so the baked raw quaternion
        // produces the correct covariance after the decode flip is re-applied.
        const [rx, ry, rz, rw] = quatMultiply(tqx, -tqy, tqz, -tqw, qx, qy, qz, qw);
        const rLen = Math.hypot(rx, ry, rz, rw) || 1;

        u8[bi + 28] = Math.round((rw / rLen) * 127.5 + 127.5);
        u8[bi + 29] = Math.round((rx / rLen) * 127.5 + 127.5);
        u8[bi + 30] = Math.round((ry / rLen) * 127.5 + 127.5);
        u8[bi + 31] = Math.round((rz / rLen) * 127.5 + 127.5);
    }

    mesh.updateData(newBuffer);
}

/**
 * Bakes the mesh's current world matrix into its splat vertices, then resets the mesh's
 * position, rotation, and scaling to identity so the visual result is unchanged.
 * @param mesh - Gaussian Splatting mesh to modify in place.
 */
export function bakeCurrentTransformIntoVertices(mesh: GaussianSplattingMesh): void {
    const transform = mesh.worldMatrix;
    bakeTransformIntoVertices(mesh, transform);
    mesh.position.x = 0;
    mesh.position.y = 0;
    mesh.position.z = 0;
    mesh.rotationQuaternion.x = 0;
    mesh.rotationQuaternion.y = 0;
    mesh.rotationQuaternion.z = 0;
    mesh.rotationQuaternion.w = 1;
    mesh.scaling.x = 1;
    mesh.scaling.y = 1;
    mesh.scaling.z = 1;
}
