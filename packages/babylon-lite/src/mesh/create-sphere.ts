import { F32, U32 } from "../engine/typed-arrays.js";
/** Procedural UV sphere — matches Babylon MeshBuilder.CreateSphere defaults.
 *  Generates vertex positions, normals, and indices for a unit sphere.
 *  Left-handed winding (CCW front face) to match Babylon. */

export interface SphereMeshData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
    indexCount: number;
}

/** Options for {@link createSphereData}. Subset of Babylon's CreateSphere. */
export interface SphereOptions {
    segments?: number;
    diameter?: number;
    diameterX?: number;
    diameterY?: number;
    diameterZ?: number;
}

/** Generate UV sphere geometry matching Babylon's CreateSphere exactly.
 *  Babylon uses: totalZ = 2 + segments rows, totalY = 2 * totalZ columns.
 *  Default: 32 segments → 35×69 = 2415 vertices. */
export function createSphereData(options: SphereOptions = {}): SphereMeshData {
    const segments = Math.max(3, options.segments ?? 32);
    const baseDiameter = options.diameter ?? 1;
    const rx = (options.diameterX ?? baseDiameter) / 2;
    const ry = (options.diameterY ?? baseDiameter) / 2;
    const rz = (options.diameterZ ?? baseDiameter) / 2;

    // Babylon's sphere tessellation formula
    const totalZRotationSteps = 2 + segments;
    const totalYRotationSteps = 2 * totalZRotationSteps;

    const totalVertices = (totalZRotationSteps + 1) * (totalYRotationSteps + 1);
    const totalIndices = totalZRotationSteps * totalYRotationSteps * 6;

    const positions = new F32(totalVertices * 3);
    const normals = new F32(totalVertices * 3);
    const uvs = new F32(totalVertices * 2);
    const indices = new U32(totalIndices);

    let vIdx = 0;
    for (let zStep = 0; zStep <= totalZRotationSteps; zStep++) {
        const normalizedZ = zStep / totalZRotationSteps;
        const angleZ = normalizedZ * Math.PI;

        for (let yStep = 0; yStep <= totalYRotationSteps; yStep++) {
            const normalizedY = yStep / totalYRotationSteps;
            const angleY = normalizedY * Math.PI * 2;

            const nx = Math.sin(angleZ) * Math.cos(angleY);
            const ny = Math.cos(angleZ);
            const nz = -Math.sin(angleZ) * Math.sin(angleY);

            positions[vIdx * 3] = rx * nx;
            positions[vIdx * 3 + 1] = ry * ny;
            positions[vIdx * 3 + 2] = rz * nz;

            normals[vIdx * 3] = nx;
            normals[vIdx * 3 + 1] = ny;
            normals[vIdx * 3 + 2] = nz;

            uvs[vIdx * 2] = normalizedY;
            uvs[vIdx * 2 + 1] = normalizedZ;

            vIdx++;
        }
    }

    // Indices — triangulate quads
    let iIdx = 0;
    for (let zStep = 0; zStep < totalZRotationSteps; zStep++) {
        for (let yStep = 0; yStep < totalYRotationSteps; yStep++) {
            const a = zStep * (totalYRotationSteps + 1) + yStep;
            const b = a + totalYRotationSteps + 1;

            indices[iIdx++] = a;
            indices[iIdx++] = a + 1;
            indices[iIdx++] = b;

            indices[iIdx++] = b;
            indices[iIdx++] = a + 1;
            indices[iIdx++] = b + 1;
        }
    }

    return {
        positions,
        normals,
        uvs,
        indices,
        vertexCount: totalVertices,
        indexCount: totalIndices,
    };
}
