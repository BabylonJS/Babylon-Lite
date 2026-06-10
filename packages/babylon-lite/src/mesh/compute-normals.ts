import { F64, U32 } from "../engine/typed-arrays.js";
/**
 * ComputeNormals — equivalent to Babylon.js VertexData.ComputeNormals for the
 * default left-handed case. Accumulates face normals per-vertex, normalizes.
 *
 * Operates on plain number arrays so callers can collect variable-length
 * geometry and typed-array convert at the end.
 */
export function computeNormals(positions: number[], indices: number[]): number[] {
    const n = positions.length;
    const pos = new F64(n);
    for (let i = 0; i < n; i++) {
        pos[i] = positions[i]!;
    }
    const idx = new U32(indices.length);
    for (let i = 0; i < indices.length; i++) {
        idx[i] = indices[i]!;
    }
    const normals = new F64(n);
    const nbFaces = (indices.length / 3) | 0;
    for (let f = 0; f < nbFaces; f++) {
        const v1x = idx[f * 3]! * 3;
        const v2x = idx[f * 3 + 1]! * 3;
        const v3x = idx[f * 3 + 2]! * 3;

        const p1p2x = pos[v1x]! - pos[v2x]!;
        const p1p2y = pos[v1x + 1]! - pos[v2x + 1]!;
        const p1p2z = pos[v1x + 2]! - pos[v2x + 2]!;
        const p3p2x = pos[v3x]! - pos[v2x]!;
        const p3p2y = pos[v3x + 1]! - pos[v2x + 1]!;
        const p3p2z = pos[v3x + 2]! - pos[v2x + 2]!;

        let nx = p1p2y * p3p2z - p1p2z * p3p2y;
        let ny = p1p2z * p3p2x - p1p2x * p3p2z;
        let nz = p1p2x * p3p2y - p1p2y * p3p2x;
        let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len === 0) {
            len = 1;
        }
        nx /= len;
        ny /= len;
        nz /= len;

        normals[v1x] = normals[v1x]! + nx;
        normals[v1x + 1] = normals[v1x + 1]! + ny;
        normals[v1x + 2] = normals[v1x + 2]! + nz;
        normals[v2x] = normals[v2x]! + nx;
        normals[v2x + 1] = normals[v2x + 1]! + ny;
        normals[v2x + 2] = normals[v2x + 2]! + nz;
        normals[v3x] = normals[v3x]! + nx;
        normals[v3x + 1] = normals[v3x + 1]! + ny;
        normals[v3x + 2] = normals[v3x + 2]! + nz;
    }
    const nVerts = (n / 3) | 0;
    const out = new Array<number>(n);
    for (let i = 0; i < nVerts; i++) {
        const x = normals[i * 3]!;
        const y = normals[i * 3 + 1]!;
        const z = normals[i * 3 + 2]!;
        let len = Math.sqrt(x * x + y * y + z * z);
        if (len === 0) {
            len = 1;
        }
        out[i * 3] = x / len;
        out[i * 3 + 1] = y / len;
        out[i * 3 + 2] = z / len;
    }
    return out;
}
