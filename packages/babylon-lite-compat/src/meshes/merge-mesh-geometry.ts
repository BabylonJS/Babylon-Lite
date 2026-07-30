import { createMeshFromData } from "babylon-lite";
import type { EngineContext, Mesh as LiteMesh } from "babylon-lite";

function fillFlatNormals(positions: Float32Array, indices: Uint32Array, indexOffset: number, indexCount: number, vertexBase: number, out: Float32Array): void {
    for (let i = 0; i < indexCount; i += 3) {
        const a = (indices[indexOffset + i]! + vertexBase) * 3;
        const b = (indices[indexOffset + i + 1]! + vertexBase) * 3;
        const c = (indices[indexOffset + i + 2]! + vertexBase) * 3;
        const ux = positions[b]! - positions[a]!;
        const uy = positions[b + 1]! - positions[a + 1]!;
        const uz = positions[b + 2]! - positions[a + 2]!;
        const vx = positions[c]! - positions[a]!;
        const vy = positions[c + 1]! - positions[a + 1]!;
        const vz = positions[c + 2]! - positions[a + 2]!;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        for (const vi of [a, b, c]) {
            out[vi] = nx;
            out[vi + 1] = ny;
            out[vi + 2] = nz;
        }
    }
}

export function mergeMeshGeometry(engine: EngineContext, name: string, meshes: readonly LiteMesh[]): LiteMesh {
    if (meshes.length === 0) {
        throw new Error("mergeMeshGeometry requires at least one mesh");
    }

    let totalVerts = 0;
    let totalIdx = 0;
    let anyUvs = false;
    for (const mesh of meshes) {
        if (!mesh._cpuPositions || !mesh._cpuIndices) {
            throw new Error(`mergeMeshGeometry: mesh "${mesh.name}" is missing CPU geometry`);
        }
        totalVerts += mesh._cpuPositions.length / 3;
        totalIdx += mesh._cpuIndices.length;
        if (mesh._cpuUvs?.length) {
            anyUvs = true;
        }
    }

    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const uvs = anyUvs ? new Float32Array(totalVerts * 2) : undefined;
    const indices = new Uint32Array(totalIdx);

    let pOff = 0;
    let iOff = 0;
    let vertBase = 0;
    for (const mesh of meshes) {
        const src = mesh._cpuPositions!;
        const srcNormals = mesh._cpuNormals;
        const srcUvs = mesh._cpuUvs;
        const wm = mesh.worldMatrix;
        const vertexCount = src.length / 3;

        const a = wm[0]!,
            b = wm[4]!,
            c = wm[8]!,
            d = wm[1]!,
            e = wm[5]!,
            f = wm[9]!,
            g = wm[2]!,
            h = wm[6]!,
            i = wm[10]!;
        const c00 = e * i - f * h,
            c01 = f * g - d * i,
            c02 = d * h - e * g,
            c10 = c * h - b * i,
            c11 = a * i - c * g,
            c12 = b * g - a * h,
            c20 = b * f - c * e,
            c21 = c * d - a * f,
            c22 = a * e - b * d;
        const determinant = a * c00 + b * c01 + c * c02;
        const normalSign = determinant < 0 ? -1 : 1;
        const reverseWinding = normalSign !== (mesh._authoredSign ?? 1);

        const meshVertexStart = pOff / 3;
        for (let v = 0; v < src.length; v += 3) {
            const x = src[v]!,
                y = src[v + 1]!,
                z = src[v + 2]!;
            positions[pOff] = x * a + y * b + z * c + wm[12]!;
            positions[pOff + 1] = x * d + y * e + z * f + wm[13]!;
            positions[pOff + 2] = x * g + y * h + z * i + wm[14]!;

            if (srcNormals) {
                const nx = srcNormals[v]!,
                    ny = srcNormals[v + 1]!,
                    nz = srcNormals[v + 2]!;
                let tx = (nx * c00 + ny * c01 + nz * c02) * normalSign;
                let ty = (nx * c10 + ny * c11 + nz * c12) * normalSign;
                let tz = (nx * c20 + ny * c21 + nz * c22) * normalSign;
                const len = Math.hypot(tx, ty, tz) || 1;
                tx /= len;
                ty /= len;
                tz /= len;
                normals[pOff] = tx;
                normals[pOff + 1] = ty;
                normals[pOff + 2] = tz;
            }
            pOff += 3;
        }

        if (uvs && srcUvs?.length) {
            uvs.set(srcUvs.subarray(0, vertexCount * 2), meshVertexStart * 2);
        }

        const meshIdx = mesh._cpuIndices!;
        const indexCount = meshIdx.length;
        const indexStart = iOff;
        for (let k = 0; k < indexCount; k += 3) {
            indices[iOff++] = meshIdx[k]! + vertBase;
            indices[iOff++] = meshIdx[k + (reverseWinding ? 2 : 1)]! + vertBase;
            indices[iOff++] = meshIdx[k + (reverseWinding ? 1 : 2)]! + vertBase;
        }

        if (!srcNormals) {
            fillFlatNormals(positions, indices, indexStart, indexCount, 0, normals);
        }

        vertBase += vertexCount;
    }

    return createMeshFromData(engine, name, positions, normals, indices, uvs);
}
