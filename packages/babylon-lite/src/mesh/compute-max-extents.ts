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
import type { BoneCornerBox } from "./aabb-corners.js";
import { buildSkinnedBoneCorners, computeMorphedRange, extentCorners, growCornersByMatrix } from "./aabb-corners.js";

const DEFAULT_FRAME_RATE = 60;

/** World-space axis-aligned extent of a single mesh. */
export interface MeshExtent {
    minimum: [number, number, number];
    maximum: [number, number, number];
}

/** Pre-built, pose-independent geometry contribution for one mesh. */
interface MeshContribution {
    /** Skinned meshes: one entry per influencing bone, corners in mesh-local bind space. */
    bones: BoneCornerBox[] | null;
    /** Non-skinned meshes: 8 AABB corners in mesh-local space. */
    corners: Float32Array | null;
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

    // Skinned: one morph-expanded bind-space box per influencing bone.
    const bones = buildSkinnedBoneCorners(mesh);
    if (bones) {
        return { bones, corners: null };
    }

    // Non-skinned: collapse the per-vertex (morph-expanded) range into a single mesh-local AABB.
    const vertexCount = (positions.length / 3) | 0;
    const { minP, maxP } = computeMorphedRange(mesh, vertexCount);
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
            const extent = extents[i]!;
            const worldMatrix = meshes[i]!.worldMatrix as unknown as ArrayLike<number>;
            if (contribution.bones) {
                const boneMatrices = meshes[i]!.skeleton!.boneMatrices;
                for (const bone of contribution.bones) {
                    mat4MultiplyInto(scratchMatrix, 0, worldMatrix as unknown as Mat4Storage, 0, boneMatrices, bone.boneIndex * 16);
                    growCornersByMatrix(bone.corners, scratchMatrix, extent.minimum, extent.maximum);
                }
            } else if (contribution.corners) {
                growCornersByMatrix(contribution.corners, worldMatrix, extent.minimum, extent.maximum);
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
