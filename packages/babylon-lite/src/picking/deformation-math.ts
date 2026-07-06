// Shared, zero-allocation deformation primitives (morph-target accumulation and skeletal skinning
// for a single vertex). Kept in their own module — rather than exported from `deformed-geometry.ts`
// — so the GPU picker's dynamic `import()` of that module does not drag these helpers into every
// picking scene's namespace object. Both the bulk (`deformed-geometry.ts`) and single-vertex
// (`deformed-vertex.ts`) paths import them via static named imports, so there is one implementation
// and no duplicated math.
//
// The primitives read and write a `Float32Array` at a caller-supplied offset. That lets the bulk
// path — which is statically imported by detailed picking and therefore inlined into every picking
// scene's bundle — call them straight over its position buffer with no per-vertex scratch/copy glue.
// The single-vertex path (only pulled into hotspot/viewer bundles) absorbs the small bridging cost of
// a length-3 scratch instead, keeping the size-sensitive bulk path as tight as a hand-inlined loop.

import type { Mesh } from "../mesh/mesh.js";

type MorphState = NonNullable<Mesh["morphTargets"]>;

/**
 * Accumulates a single vertex's active morph-target position offsets directly onto the vec3 stored at
 * `outOffset` in `out`, in place (zero-allocation). Reading and writing the same buffer at the same
 * offset lets the bulk path call this per vertex with no scratch/copy glue; the single-vertex path
 * passes a length-3 scratch (`outOffset` 0) whose morph deltas still come from `componentOffset`.
 *
 * @param morph - The mesh's morph-target state.
 * @param out - Buffer holding the vertex's current position at `outOffset`; updated in place.
 * @param outOffset - Index of the vertex's x component within `out`.
 * @param componentOffset - The vertex's base index into the morph target position buffers
 *   (vertexIndex * 3). Equals `outOffset` for the bulk path; differs when `out` is a scratch.
 */
export function addMorphDelta(morph: MorphState, out: Float32Array, outOffset: number, componentOffset: number): void {
    let x = out[outOffset]!;
    let y = out[outOffset + 1]!;
    let z = out[outOffset + 2]!;
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
    out[outOffset] = x;
    out[outOffset + 1] = y;
    out[outOffset + 2] = z;
}

// Scratch reused by skinVec3ToRef for each bone transform to keep it zero-allocation.
const _boneTransformScratch: [number, number, number] = [0, 0, 0];

/**
 * Applies bone-blended skinning to a single vertex, writing the skinned vec3 directly to `outOffset`
 * in `out` (zero-allocation). `wCoord` is 1 for positions (bone translation applies) and 0 for
 * normals. The source components are passed as scalars so the caller can read from a separate,
 * unmodified copy while this writes into `out` (the bulk path relies on that to skin in place).
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
 * @param out - Destination buffer; the skinned vec3 is written at `outOffset`.
 * @param outOffset - Index of the destination x component within `out`.
 */
export function skinVertexToRef(
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
    out: Float32Array,
    outOffset: number
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

    out[outOffset] = rx;
    out[outOffset + 1] = ry;
    out[outOffset + 2] = rz;
}

/** Zero-allocation bone transform: writes `boneMatrix * [x, y, z, wCoord]` (xyz) into `out`. */
function transformByBoneToRef(boneMatrices: Float32Array, joint: number, x: number, y: number, z: number, wCoord: 0 | 1, out: [number, number, number]): void {
    const o = joint * 16;
    out[0] = boneMatrices[o]! * x + boneMatrices[o + 4]! * y + boneMatrices[o + 8]! * z + boneMatrices[o + 12]! * wCoord;
    out[1] = boneMatrices[o + 1]! * x + boneMatrices[o + 5]! * y + boneMatrices[o + 9]! * z + boneMatrices[o + 13]! * wCoord;
    out[2] = boneMatrices[o + 2]! * x + boneMatrices[o + 6]! * y + boneMatrices[o + 10]! * z + boneMatrices[o + 14]! * wCoord;
}
