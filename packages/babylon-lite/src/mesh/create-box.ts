import { F32, U32 } from "../engine/typed-arrays.js";
/**
 * CreateBox — procedural box mesh matching Babylon.js MeshBuilder.CreateBox()
 *
 * Generates a unit box (size=1, extends from -0.5 to 0.5) with:
 * - 24 vertices (4 per face × 6 faces)
 * - 36 indices (2 triangles per face × 6 faces)
 * - Per-face normals (axis-aligned)
 *
 * Face order matches Babylon exactly: +Z, -Z, +X, -X, +Y, -Y
 */

export interface BoxData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
    indexCount: number;
}

/** Options for box dimensions. Explicit axis dimensions override `size`. */
export interface BoxOptions {
    size?: number;
    width?: number;
    height?: number;
    depth?: number;
}

// One bit per coordinate in face order: 1 = +0.5, 0 = -0.5.
const BOX_POSITION_SIGNS = [0x4b213fa5, 0xded6426f, 0x80] as const;

// prettier-ignore
const BOX_NORMALS = new F32([
  // +Z
  0, 0, 1,   0, 0, 1,   0, 0, 1,   0, 0, 1,
  // -Z
  0, 0,-1,   0, 0,-1,   0, 0,-1,   0, 0,-1,
  // +X
  1, 0, 0,   1, 0, 0,   1, 0, 0,   1, 0, 0,
  // -X
 -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
  // +Y
  0, 1, 0,   0, 1, 0,   0, 1, 0,   0, 1, 0,
  // -Y
  0,-1, 0,   0,-1, 0,   0,-1, 0,   0,-1, 0,
]);

// prettier-ignore
const BOX_UVS = new F32([
  // Each face: (1,1), (0,1), (0,0), (1,0) — matching BJS box UV layout
  1, 1,  0, 1,  0, 0,  1, 0,  // +Z
  1, 1,  0, 1,  0, 0,  1, 0,  // -Z
  1, 1,  0, 1,  0, 0,  1, 0,  // +X
  1, 1,  0, 1,  0, 0,  1, 0,  // -X
  1, 1,  0, 1,  0, 0,  1, 0,  // +Y
  1, 1,  0, 1,  0, 0,  1, 0,  // -Y
]);

// prettier-ignore
const BOX_INDICES = new U32([
   0,  1,  2,   0,  2,  3,
   4,  5,  6,   4,  6,  7,
   8,  9, 10,   8, 10, 11,
  12, 13, 14,  12, 14, 15,
  16, 17, 18,  16, 18, 19,
  20, 21, 22,  20, 22, 23,
]);

/**
 * Create box CPU data. A number sets a uniform size; structured options can set
 * independent dimensions, with `size` as the fallback for unspecified axes.
 *
 * Always returns freshly-allocated typed arrays (never the shared module-level
 * constants), matching the other primitive data factories (createSphereData,
 * createCylinderData, …). This keeps the public API safe: callers may freely
 * mutate the returned buffers without corrupting subsequent calls.
 */
export function createBoxData(options: number | BoxOptions = 1): BoxData {
    let dimensions: number[];
    if (typeof options === "number") {
        dimensions = [options, options, options];
    } else {
        const { size = 1, width = size, height = size, depth = size } = options;
        dimensions = [width, height, depth];
    }

    const positions = new F32(72);
    for (let index = 0; index < positions.length; index++) {
        const sign = (BOX_POSITION_SIGNS[index >> 5]! >>> (index & 31)) & 1;
        positions[index] = (sign - 0.5) * dimensions[index % 3]!;
    }
    return {
        positions,
        normals: BOX_NORMALS.slice(),
        uvs: BOX_UVS.slice(),
        indices: BOX_INDICES.slice(),
        vertexCount: 24,
        indexCount: 36,
    };
}
