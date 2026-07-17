// Shared AABB-corner primitives for world-space mesh bounds.
//
// Two consumers fold a mesh's geometry into a world-space AABB from its bind-pose
// corners: camera framing (`compute-max-extents`, swept across an animation) and
// shadow-caster frustum fitting (`shadow/caster-world-aabb`, at the current pose).
// Both need the same skinning-aware corner math, so it lives here once rather than
// being duplicated: build per-bone bind-space corner boxes, then transform each box
// by `worldMatrix · boneMatrices[bone]` — the exact skinning matrix the GPU uses —
// growing a running min/max. Non-skinned helpers (`extentCorners`,
// `computeMorphedRange`) are shared too so a single implementation serves both.
//
// Standalone and side-effect-free: only pulled into a bundle when imported.

import { F32 } from "../engine/typed-arrays.js";
import type { Mesh } from "./mesh.js";

/** One influencing bone's 8 AABB corners, in mesh-local bind space. */
export interface BoneCornerBox {
    boneIndex: number;
    /** 24 floats: 8 corners × xyz. */
    corners: Float32Array;
}

/** Build the 8 corners (as a flat 24-float buffer) of an AABB. */
export function extentCorners(min: ArrayLike<number>, max: ArrayLike<number>): Float32Array {
    const c = new F32(24);
    for (let i = 0; i < 8; i++) {
        c[i * 3] = i & 1 ? max[0]! : min[0]!;
        c[i * 3 + 1] = i & 2 ? max[1]! : min[1]!;
        c[i * 3 + 2] = i & 4 ? max[2]! : min[2]!;
    }
    return c;
}

/** Per-vertex min/max positions, expanded by each morph target's deltas. */
export function computeMorphedRange(mesh: Mesh, vertexCount: number): { minP: Float32Array; maxP: Float32Array } {
    const positions = mesh._cpuPositions!;
    const componentCount = vertexCount * 3;
    const minP = new F32(positions.subarray(0, componentCount));
    const maxP = new F32(minP);
    const morph = mesh.morphTargets;
    if (morph) {
        // Bound each morph target independently against the base (per component). This mirrors Babylon.js
        // core's `computeMaxExtents`, which takes the per-vertex AABB of {base, target0, target1, ...}
        // where core's `MorphTarget.getPositions()` returns absolute positions and Lite stores deltas
        // (base + delta == core's absolute target position). Matching core exactly is intentional: the
        // full Viewer frames from core's result, so the ViewerLite camera must frame identically. Note
        // this does NOT bound targets stacking together, but neither does core; if a wider conservative
        // bound is ever wanted it should be changed in core first so the two stay in sync.
        for (const target of morph.targets) {
            const deltas = target.positions;
            const count = Math.min(deltas.length, componentCount);
            for (let i = 0; i < count; i++) {
                const p = positions[i]! + deltas[i]!;
                if (p < minP[i]!) {
                    minP[i] = p;
                }
                if (p > maxP[i]!) {
                    maxP[i] = p;
                }
            }
        }
    }
    return { minP, maxP };
}

/** Build per-bone bind-space corner boxes for a skinned mesh, or `null` when the
 *  mesh is not skinned or has no CPU geometry. Each vertex's (morph-expanded)
 *  bind-pose range is accumulated into a box for every bone that influences it, so
 *  transforming those 8 corners per bone captures the skinned volume cheaply (8
 *  corners per bone, not every vertex). Built once from static bind data; the
 *  per-frame pose enters only through `boneMatrices` at transform time. */
export function buildSkinnedBoneCorners(mesh: Mesh): BoneCornerBox[] | null {
    const positions = mesh._cpuPositions;
    const skeleton = mesh.skeleton;
    if (!positions || positions.length === 0 || !skeleton || !skeleton.weights) {
        return null;
    }

    const vertexCount = (positions.length / 3) | 0;
    const { minP, maxP } = computeMorphedRange(mesh, vertexCount);

    const boneCount = skeleton.boneCount;
    const boneMin = new F32(boneCount * 3).fill(Number.POSITIVE_INFINITY);
    const boneMax = new F32(boneCount * 3).fill(Number.NEGATIVE_INFINITY);
    const boneUsed = new Uint8Array(boneCount);

    const accumulate = (joints: Uint8Array | Uint16Array, weights: Float32Array, vertex: number): void => {
        const base = vertex * 4;
        for (let k = 0; k < 4; k++) {
            if (weights[base + k]! > 0) {
                const bone = joints[base + k]!;
                if (bone < boneCount) {
                    const bo = bone * 3;
                    const vo = vertex * 3;
                    if (minP[vo]! < boneMin[bo]!) {
                        boneMin[bo] = minP[vo]!;
                    }
                    if (minP[vo + 1]! < boneMin[bo + 1]!) {
                        boneMin[bo + 1] = minP[vo + 1]!;
                    }
                    if (minP[vo + 2]! < boneMin[bo + 2]!) {
                        boneMin[bo + 2] = minP[vo + 2]!;
                    }
                    if (maxP[vo]! > boneMax[bo]!) {
                        boneMax[bo] = maxP[vo]!;
                    }
                    if (maxP[vo + 1]! > boneMax[bo + 1]!) {
                        boneMax[bo + 1] = maxP[vo + 1]!;
                    }
                    if (maxP[vo + 2]! > boneMax[bo + 2]!) {
                        boneMax[bo + 2] = maxP[vo + 2]!;
                    }
                    boneUsed[bone] = 1;
                }
            }
        }
    };

    const joints0 = skeleton.joints;
    const weights0 = skeleton.weights;
    const joints1 = skeleton.joints1;
    const weights1 = skeleton.weights1;
    for (let v = 0; v < vertexCount; v++) {
        accumulate(joints0, weights0, v);
        if (joints1 && weights1) {
            accumulate(joints1, weights1, v);
        }
    }

    const bones: BoneCornerBox[] = [];
    for (let b = 0; b < boneCount; b++) {
        if (boneUsed[b]) {
            const o = b * 3;
            bones.push({
                boneIndex: b,
                corners: extentCorners([boneMin[o]!, boneMin[o + 1]!, boneMin[o + 2]!], [boneMax[o]!, boneMax[o + 1]!, boneMax[o + 2]!]),
            });
        }
    }
    return bones;
}

/** Transform the 8 `corners` by `matrix` (column-major 4x4) and grow `min`/`max`
 *  (length-3 arrays) to include the transformed points. */
export function growCornersByMatrix(corners: Float32Array, matrix: ArrayLike<number>, min: number[], max: number[]): void {
    const m0 = matrix[0]!,
        m1 = matrix[1]!,
        m2 = matrix[2]!,
        m4 = matrix[4]!,
        m5 = matrix[5]!,
        m6 = matrix[6]!,
        m8 = matrix[8]!,
        m9 = matrix[9]!,
        m10 = matrix[10]!,
        m12 = matrix[12]!,
        m13 = matrix[13]!,
        m14 = matrix[14]!;
    for (let i = 0; i < 8; i++) {
        const lx = corners[i * 3]!;
        const ly = corners[i * 3 + 1]!;
        const lz = corners[i * 3 + 2]!;
        const x = m0 * lx + m4 * ly + m8 * lz + m12;
        const y = m1 * lx + m5 * ly + m9 * lz + m13;
        const z = m2 * lx + m6 * ly + m10 * lz + m14;
        if (x < min[0]!) {
            min[0] = x;
        }
        if (y < min[1]!) {
            min[1] = y;
        }
        if (z < min[2]!) {
            min[2] = z;
        }
        if (x > max[0]!) {
            max[0] = x;
        }
        if (y > max[1]!) {
            max[1] = y;
        }
        if (z > max[2]!) {
            max[2] = z;
        }
    }
}
