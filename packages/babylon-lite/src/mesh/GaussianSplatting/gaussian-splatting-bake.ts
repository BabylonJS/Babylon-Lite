import { F32, U8 } from "../../engine/typed-arrays.js";
import type { GaussianSplattingMesh } from "./gaussian-splatting-mesh.js";
import type { Mat4 } from "../../math/types.js";
import { mat4Decompose } from "../../math/mat4-decompose.js";

const ROW_LENGTH = 32;

function mat4TransformCoord(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
    const w = 1.0 / (m[3]! * x + m[7]! * y + m[11]! * z + m[15]!);
    return [(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * w, (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * w, (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * w];
}

function mat4ToRotationQuat(m: Float32Array): [number, number, number, number] {
    // Delegates to mat4Decompose: it strips per-axis scale AND folds a mirrored basis (negative
    // determinant) onto a signed axis. Normalising the columns independently would hand an improper
    // basis to the quaternion conversion, producing a garbage orientation for every splat.
    const q = mat4Decompose(m as unknown as Mat4).rotation;
    return [q.x, q.y, q.z, q.w];
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
    const u8 = new U8(newBuffer);
    const f32 = new F32(newBuffer);
    const splatCount = (u8.byteLength / ROW_LENGTH) | 0;

    const m = new F32(transform as unknown as ArrayLike<number>);

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
