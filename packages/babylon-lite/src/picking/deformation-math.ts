// Shared, zero-allocation deformation primitives (morph-target accumulation and skeletal skinning
// for a single vertex). Kept in their own module — rather than exported from `deformed-geometry.ts`
// — so the GPU picker's dynamic `import()` of that module does not drag these helpers into every
// picking scene's namespace object. Both the bulk (`deformed-geometry.ts`) and single-vertex
// (`deformed-vertex.ts`) paths import them via static named imports, so there is one implementation
// and no duplicated math.

import type { Mesh } from "../mesh/mesh.js";

type MorphState = NonNullable<Mesh["morphTargets"]>;

/**
 * Accumulates a single vertex's active morph-target position offsets onto (x, y, z) and writes the
 * result into `out`. `componentOffset` is the vertex's base index into the flat position buffer
 * (vertexIndex * 3).
 *
 * @param morph - The mesh's morph-target state.
 * @param componentOffset - The vertex's base index into the flat position buffer (vertexIndex * 3).
 * @param x - The vertex's current x component (typically the base or already-morphed position).
 * @param y - The vertex's current y component.
 * @param z - The vertex's current z component.
 * @param out - Destination vec3, written in place (zero-allocation).
 */
export function morphVec3ToRef(morph: MorphState, componentOffset: number, x: number, y: number, z: number, out: [number, number, number]): void {
    const targetCount = Math.min(morph.count, morph.targets.length);
    for (let t = 0; t < targetCount; t++) {
        const weight = morph.weights[t] ?? 0;
        if (weight === 0) {
            continue;
        }
        const positions = morph.targets[t]!.positions;
        x += positions[componentOffset]! * weight;
        y += positions[componentOffset + 1]! * weight;
        z += positions[componentOffset + 2]! * weight;
    }
    out[0] = x;
    out[1] = y;
    out[2] = z;
}

// Scratch reused by skinVec3ToRef for each bone transform to keep it zero-allocation.
const _boneTransformScratch: [number, number, number] = [0, 0, 0];

/**
 * Applies bone-blended skinning to a single vertex, writing the skinned vec3 into `out`
 * (zero-allocation). `wCoord` is 1 for positions (bone translation applies) and 0 for normals.
 *
 * @param boneMatrices - Flat column-major 4x4 bone matrices (16 floats per bone).
 * @param joints - Primary 4-joint indices per vertex.
 * @param weights - Primary 4-joint weights per vertex.
 * @param joints1 - Secondary 4-joint indices (8-bone skinning), or null.
 * @param weights1 - Secondary 4-joint weights (8-bone skinning), or null.
 * @param vertexIndex - Vertex index (indexes joints/weights in groups of 4).
 * @param x - The vertex's x component.
 * @param y - The vertex's y component.
 * @param z - The vertex's z component.
 * @param wCoord - 1 for positions, 0 for normals.
 * @param out - Destination vec3, written in place (zero-allocation).
 */
export function skinVec3ToRef(
    boneMatrices: Float32Array,
    joints: Uint16Array | Uint8Array,
    weights: Float32Array,
    joints1: Uint16Array | Uint8Array | null,
    weights1: Float32Array | null,
    vertexIndex: number,
    x: number,
    y: number,
    z: number,
    wCoord: 0 | 1,
    out: [number, number, number]
): void {
    let rx = 0;
    let ry = 0;
    let rz = 0;
    const base = vertexIndex * 4;

    for (let i = 0; i < 4; i++) {
        const weight = weights[base + i] ?? 0;
        if (weight !== 0) {
            transformByBoneToRef(boneMatrices, joints[base + i] ?? 0, x, y, z, wCoord, _boneTransformScratch);
            rx += _boneTransformScratch[0] * weight;
            ry += _boneTransformScratch[1] * weight;
            rz += _boneTransformScratch[2] * weight;
        }
    }

    if (joints1 && weights1) {
        for (let i = 0; i < 4; i++) {
            const weight = weights1[base + i] ?? 0;
            if (weight !== 0) {
                transformByBoneToRef(boneMatrices, joints1[base + i] ?? 0, x, y, z, wCoord, _boneTransformScratch);
                rx += _boneTransformScratch[0] * weight;
                ry += _boneTransformScratch[1] * weight;
                rz += _boneTransformScratch[2] * weight;
            }
        }
    }

    out[0] = rx;
    out[1] = ry;
    out[2] = rz;
}

/** Zero-allocation bone transform: writes `boneMatrix * [x, y, z, wCoord]` (xyz) into `out`. */
function transformByBoneToRef(boneMatrices: Float32Array, joint: number, x: number, y: number, z: number, wCoord: 0 | 1, out: [number, number, number]): void {
    const o = joint * 16;
    out[0] = boneMatrices[o]! * x + boneMatrices[o + 4]! * y + boneMatrices[o + 8]! * z + boneMatrices[o + 12]! * wCoord;
    out[1] = boneMatrices[o + 1]! * x + boneMatrices[o + 5]! * y + boneMatrices[o + 9]! * z + boneMatrices[o + 13]! * wCoord;
    out[2] = boneMatrices[o + 2]! * x + boneMatrices[o + 6]! * y + boneMatrices[o + 10]! * z + boneMatrices[o + 14]! * wCoord;
}
