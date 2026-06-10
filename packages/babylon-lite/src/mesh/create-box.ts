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

// prettier-ignore
const BOX_POSITIONS = new F32([
  // +Z face
   0.5, -0.5,  0.5,   -0.5, -0.5,  0.5,   -0.5,  0.5,  0.5,    0.5,  0.5,  0.5,
  // -Z face
   0.5,  0.5, -0.5,   -0.5,  0.5, -0.5,   -0.5, -0.5, -0.5,    0.5, -0.5, -0.5,
  // +X face
   0.5,  0.5, -0.5,    0.5, -0.5, -0.5,    0.5, -0.5,  0.5,    0.5,  0.5,  0.5,
  // -X face
  -0.5,  0.5,  0.5,   -0.5, -0.5,  0.5,   -0.5, -0.5, -0.5,   -0.5,  0.5, -0.5,
  // +Y face
  -0.5,  0.5,  0.5,   -0.5,  0.5, -0.5,    0.5,  0.5, -0.5,    0.5,  0.5,  0.5,
  // -Y face
   0.5, -0.5,  0.5,    0.5, -0.5, -0.5,   -0.5, -0.5, -0.5,   -0.5, -0.5,  0.5,
]);

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

/** Create box CPU data. `size` scales all positions (default 1). */
export function createBoxData(size = 1): BoxData {
    if (size === 1) {
        return {
            positions: BOX_POSITIONS,
            normals: BOX_NORMALS,
            uvs: BOX_UVS,
            indices: BOX_INDICES,
            vertexCount: 24,
            indexCount: 36,
        };
    }
    const positions = new F32(BOX_POSITIONS.length);
    for (let i = 0; i < positions.length; i++) {
        positions[i] = BOX_POSITIONS[i]! * size;
    }
    return {
        positions,
        normals: BOX_NORMALS,
        uvs: BOX_UVS,
        indices: BOX_INDICES,
        vertexCount: 24,
        indexCount: 36,
    };
}
