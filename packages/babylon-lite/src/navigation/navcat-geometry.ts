import type { Mesh } from "../mesh/mesh.js";
import type { NavcatGeometry } from "./navcat-types.js";
import { mat4Determinant3 } from "../math/mat4-determinant3.js";

/** Extract selected static CPU triangles, transformed to RH/CCW world geometry for Navcat. */
export function extractNavcatGeometry(meshes: readonly Mesh[]): NavcatGeometry {
    if (meshes.length === 0) {
        throw new Error("Navcat geometry needs at least one mesh");
    }
    let positionCount = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
        const p = mesh._cpuPositions;
        const ix = mesh._cpuIndices;
        const primitive = (mesh as Mesh & { _primitive?: { topology?: string } })._primitive;
        if (
            mesh._disposed ||
            !p ||
            !ix ||
            p.length === 0 ||
            p.length % 3 !== 0 ||
            ix.length === 0 ||
            ix.length % 3 !== 0 ||
            mesh._topology ||
            (primitive?.topology && primitive.topology !== "triangle-list") ||
            mesh.skeleton ||
            mesh.morphTargets ||
            mesh.vat ||
            mesh.thinInstances
        ) {
            throw new Error("Navcat extraction requires live static CPU triangle-list geometry");
        }
        positionCount += p.length;
        indexCount += ix.length;
    }
    const positions = new Float64Array(positionCount);
    const indices = new Uint32Array(indexCount);
    let positionOffset = 0;
    let indexOffset = 0;
    for (const mesh of meshes) {
        const p = mesh._cpuPositions!;
        const ix = mesh._cpuIndices!;
        const m = mesh.worldMatrix;
        const determinant = mat4Determinant3(m);
        for (let i = 0; i < 16; i++) {
            if (!Number.isFinite(m[i])) {
                throw new Error("Navcat extraction requires a nonsingular finite affine transform");
            }
        }
        if (!Number.isFinite(determinant) || determinant === 0 || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) {
            throw new Error("Navcat extraction requires a nonsingular finite affine transform");
        }
        const vertexOffset = positionOffset / 3;
        for (let i = 0; i < p.length; i += 3) {
            const x = p[i]!,
                y = p[i + 1]!,
                z = p[i + 2]!;
            const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
            const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
            const wz = -(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
            if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) {
                throw new Error("Navcat geometry contains nonfinite positions");
            }
            positions[positionOffset++] = wx;
            positions[positionOffset++] = wy;
            positions[positionOffset++] = wz;
        }
        const reverse = (determinant < 0 ? -1 : 1) !== (mesh._authoredSign ?? 1);
        const vertexCount = p.length / 3;
        for (let i = 0; i < ix.length; i += 3) {
            const a = ix[i]!,
                b = ix[i + 1]!,
                c = ix[i + 2]!;
            if (!Number.isInteger(a) || a < 0 || a >= vertexCount || !Number.isInteger(b) || b < 0 || b >= vertexCount || !Number.isInteger(c) || c < 0 || c >= vertexCount) {
                throw new Error("Navcat geometry has an invalid triangle index");
            }
            indices[indexOffset++] = vertexOffset + a;
            indices[indexOffset++] = vertexOffset + (reverse ? c : b);
            indices[indexOffset++] = vertexOffset + (reverse ? b : c);
        }
    }
    return { positions, indices };
}
