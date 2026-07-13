// Animation-aware world-space mesh extents for camera framing.
//
// Computes the maximum world-space AABB swept by each mesh across an animation —
// covering node (TRS) animation, skeletal skinning, and morph targets. Mirrors the
// approach proven by Babylon.js core's `computeMaxExtents`, adapted to Lite's data:
//
//   - Non-skinned meshes contribute their local AABB (expanded by morph deltas)
//     transformed by the mesh's per-frame world matrix.
//   - Skinned meshes are bounded per-bone: every vertex's (morph-expanded) bind-pose
//     position is accumulated into a box for each bone that influences it, in mesh-local
//     bind space. Per frame, each bone box's 8 corners are transformed by
//     `worldMatrix · boneMatrices[bone]` — the same skinning matrix the GPU uses — so the
//     swept skinned volume is captured cheaply (8 corners per bone, not every vertex).
//
// The animation is stepped at a fixed time interval; the union of all sampled poses gives
// a stable framing box. The group's playback state (time + playing) is saved and restored.
//
// Standalone and side-effect-free: only pulled into a bundle when imported.

import type { Mat4Storage } from "../math/types.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { goToFrame } from "../animation/animation-group.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "./mesh.js";

const DEFAULT_FRAME_RATE = 60;

/** World-space axis-aligned extent of a single mesh. */
export interface MeshExtent {
    minimum: [number, number, number];
    maximum: [number, number, number];
}

/** Pre-built, pose-independent geometry contribution for one mesh. */
interface MeshContribution {
    /** Skinned meshes: one entry per influencing bone, corners in mesh-local bind space. */
    bones: Array<{ boneIndex: number; corners: Float32Array }> | null;
    /** Non-skinned meshes: 8 AABB corners in mesh-local space. */
    corners: Float32Array | null;
}

/** Build the 8 corners (as a flat 24-float buffer) of an AABB. */
function extentCorners(min: ArrayLike<number>, max: ArrayLike<number>): Float32Array {
    const c = new Float32Array(24);
    for (let i = 0; i < 8; i++) {
        c[i * 3] = i & 1 ? max[0]! : min[0]!;
        c[i * 3 + 1] = i & 2 ? max[1]! : min[1]!;
        c[i * 3 + 2] = i & 4 ? max[2]! : min[2]!;
    }
    return c;
}

/** Per-vertex min/max positions, expanded by each morph target's deltas. */
function computeMorphedRange(mesh: Mesh, vertexCount: number): { minP: Float32Array; maxP: Float32Array } {
    const positions = mesh._cpuPositions!;
    const componentCount = vertexCount * 3;
    const minP = new Float32Array(positions.subarray(0, componentCount));
    const maxP = new Float32Array(minP);
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

/** Build the pose-independent contribution (per-bone or single AABB corners) for one mesh. */
function buildContribution(mesh: Mesh): MeshContribution {
    const positions = mesh._cpuPositions;
    if (!positions || positions.length === 0) {
        // No CPU geometry: fall back to the loader-provided local AABB if present.
        if (mesh.boundMin && mesh.boundMax) {
            return { bones: null, corners: extentCorners(mesh.boundMin, mesh.boundMax) };
        }
        return { bones: null, corners: null };
    }

    const vertexCount = (positions.length / 3) | 0;
    const { minP, maxP } = computeMorphedRange(mesh, vertexCount);

    const skeleton = mesh.skeleton;
    if (skeleton && skeleton.weights) {
        // Skinned: accumulate each vertex's range into every bone that influences it.
        const boneCount = skeleton.boneCount;
        const boneMin = new Float32Array(boneCount * 3).fill(Number.POSITIVE_INFINITY);
        const boneMax = new Float32Array(boneCount * 3).fill(Number.NEGATIVE_INFINITY);
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

        const bones: Array<{ boneIndex: number; corners: Float32Array }> = [];
        for (let b = 0; b < boneCount; b++) {
            if (boneUsed[b]) {
                const o = b * 3;
                bones.push({
                    boneIndex: b,
                    corners: extentCorners([boneMin[o]!, boneMin[o + 1]!, boneMin[o + 2]!], [boneMax[o]!, boneMax[o + 1]!, boneMax[o + 2]!]),
                });
            }
        }
        return { bones, corners: null };
    }

    // Non-skinned: collapse the per-vertex range into a single mesh-local AABB.
    let minX = Number.POSITIVE_INFINITY,
        minY = Number.POSITIVE_INFINITY,
        minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY,
        maxY = Number.NEGATIVE_INFINITY,
        maxZ = Number.NEGATIVE_INFINITY;
    for (let v = 0; v < vertexCount; v++) {
        const o = v * 3;
        if (minP[o]! < minX) {
            minX = minP[o]!;
        }
        if (minP[o + 1]! < minY) {
            minY = minP[o + 1]!;
        }
        if (minP[o + 2]! < minZ) {
            minZ = minP[o + 2]!;
        }
        if (maxP[o]! > maxX) {
            maxX = maxP[o]!;
        }
        if (maxP[o + 1]! > maxY) {
            maxY = maxP[o + 1]!;
        }
        if (maxP[o + 2]! > maxZ) {
            maxZ = maxP[o + 2]!;
        }
    }
    return { bones: null, corners: extentCorners([minX, minY, minZ], [maxX, maxY, maxZ]) };
}

/** Transform the 8 corners by `matrix` (column-major) and grow `extent`. */
function accumulateCorners(corners: Float32Array, matrix: ArrayLike<number>, extent: MeshExtent): void {
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
    const min = extent.minimum;
    const max = extent.maximum;
    for (let i = 0; i < 8; i++) {
        const lx = corners[i * 3]!;
        const ly = corners[i * 3 + 1]!;
        const lz = corners[i * 3 + 2]!;
        const x = m0 * lx + m4 * ly + m8 * lz + m12;
        const y = m1 * lx + m5 * ly + m9 * lz + m13;
        const z = m2 * lx + m6 * ly + m10 * lz + m14;
        if (x < min[0]) {
            min[0] = x;
        }
        if (y < min[1]) {
            min[1] = y;
        }
        if (z < min[2]) {
            min[2] = z;
        }
        if (x > max[0]) {
            max[0] = x;
        }
        if (y > max[1]) {
            max[1] = y;
        }
        if (z > max[2]) {
            max[2] = z;
        }
    }
}

/**
 * Computes the maximum world-space extents of the given meshes, optionally stepping through an
 * animation to capture the full swept volume (node, skeletal, and morph-target animation).
 *
 * @param meshes - The meshes to bound (e.g. from {@link getContainerMeshes}).
 * @param animationGroup - An optional animation group to sample across its duration. When omitted
 *   (or zero-length), the meshes are bounded once at their current pose.
 * @param engine - The engine context. Required when `animationGroup` drives skinned or morph-target
 *   meshes, because seeking the animation uploads the resulting pose to the GPU.
 * @param animationStep - Sampling interval in seconds while stepping the animation. Defaults to 1/6.
 * @returns One world-space extent per input mesh (parallel to `meshes`). A mesh with no geometry
 *   contributes an inverted extent (`+Inf`/`-Inf`).
 */
export function computeMaxExtents(meshes: readonly Mesh[], animationGroup: AnimationGroup | null = null, engine: EngineContext | null = null, animationStep = 1 / 6): MeshExtent[] {
    const contributions = meshes.map(buildContribution);
    const extents: MeshExtent[] = meshes.map(() => ({
        minimum: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        maximum: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    }));

    const scratchMatrix = new Float32Array(16);

    const updateExtents = (): void => {
        for (let i = 0; i < meshes.length; i++) {
            const contribution = contributions[i]!;
            const worldMatrix = meshes[i]!.worldMatrix as unknown as ArrayLike<number>;
            if (contribution.bones) {
                const boneMatrices = meshes[i]!.skeleton!.boneMatrices;
                for (const bone of contribution.bones) {
                    mat4MultiplyInto(scratchMatrix, 0, worldMatrix as unknown as Mat4Storage, 0, boneMatrices, bone.boneIndex * 16);
                    accumulateCorners(bone.corners, scratchMatrix, extents[i]!);
                }
            } else if (contribution.corners) {
                accumulateCorners(contribution.corners, worldMatrix, extents[i]!);
            }
        }
    };

    if (animationGroup && animationGroup.duration > 0) {
        const frameRate = animationGroup.frameRate || DEFAULT_FRAME_RATE;
        const savedTime = animationGroup.currentTime;
        const savedPlaying = animationGroup.isPlaying;
        const savedStopped = animationGroup._stopped;
        const step = Math.max(animationStep, 1e-3);
        const engineArg = engine ?? undefined;

        // Force the group out of the "stopped" state while sampling. Otherwise `goToFrame` skips the
        // controller tick for a stopped glTF-mixer group when no engine is supplied (see goToFrame),
        // so the sampled poses would never advance and the swept volume would collapse to the rest
        // pose. Restored below alongside time and playing state.
        animationGroup._stopped = false;

        for (let time = 0; time <= animationGroup.duration; time += step) {
            goToFrame(animationGroup, time * frameRate, engineArg);
            updateExtents();
        }

        // Restore the original playback position and state.
        goToFrame(animationGroup, savedTime * frameRate, engineArg);
        animationGroup._stopped = savedStopped;
        animationGroup.isPlaying = savedPlaying;
    } else {
        updateExtents();
    }

    return extents;
}
