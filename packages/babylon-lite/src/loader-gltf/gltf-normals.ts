/** glTF smooth-normal generation — dynamically imported.
 *
 *  Isolated from the core loader so scenes whose assets always provide the NORMAL
 *  attribute (the common case) never bundle or fetch this code. Loaded lazily by
 *  `load-gltf.ts` only when a primitive omits NORMAL.
 *
 *  Zero module-level side effects — safe for tree-shaking.
 */

/** Compute smooth (area-weighted) vertex normals from positions + indices. Used when a glTF
 *  primitive omits the NORMAL attribute (the spec allows this and requires clients to generate
 *  normals — e.g. THREE.GLTFExporter output for morph-only meshes). */
export function computeSmoothNormals(positions: Float32Array, indices: Uint16Array | Uint32Array, vertexCount: number): Float32Array {
    const normals = new Float32Array(vertexCount * 3);
    const indexed = indices.length > 0;
    const triCount = indexed ? (indices.length / 3) | 0 : (vertexCount / 3) | 0;
    for (let f = 0; f < triCount; f++) {
        const ia = indexed ? indices[f * 3]! : f * 3;
        const ib = indexed ? indices[f * 3 + 1]! : f * 3 + 1;
        const ic = indexed ? indices[f * 3 + 2]! : f * 3 + 2;
        const ax = positions[ia * 3]!,
            ay = positions[ia * 3 + 1]!,
            az = positions[ia * 3 + 2]!;
        const bx = positions[ib * 3]!,
            by = positions[ib * 3 + 1]!,
            bz = positions[ib * 3 + 2]!;
        const cx = positions[ic * 3]!,
            cy = positions[ic * 3 + 1]!,
            cz = positions[ic * 3 + 2]!;
        const e1x = bx - ax,
            e1y = by - ay,
            e1z = bz - az;
        const e2x = cx - ax,
            e2y = cy - ay,
            e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y,
            ny = e1z * e2x - e1x * e2z,
            nz = e1x * e2y - e1y * e2x;
        normals[ia * 3]! += nx;
        normals[ia * 3 + 1]! += ny;
        normals[ia * 3 + 2]! += nz;
        normals[ib * 3]! += nx;
        normals[ib * 3 + 1]! += ny;
        normals[ib * 3 + 2]! += nz;
        normals[ic * 3]! += nx;
        normals[ic * 3 + 1]! += ny;
        normals[ic * 3 + 2]! += nz;
    }
    for (let i = 0; i < vertexCount; i++) {
        const x = normals[i * 3]!,
            y = normals[i * 3 + 1]!,
            z = normals[i * 3 + 2]!;
        const len = Math.hypot(x, y, z) || 1;
        normals[i * 3] = x / len;
        normals[i * 3 + 1] = y / len;
        normals[i * 3 + 2] = z / len;
    }
    return normals;
}
