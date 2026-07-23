// Skeletal shadow-caster world AABBs, split into their own optional module so
// morph-only shadow scenes never pay for per-bone corner construction or matrix math.

import { F32 } from "../engine/typed-arrays.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";
import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MorphTargetData, SkeletonData } from "../animation/types.js";
import { _installDeformationChangeNotifier } from "../animation/deformation-change-hooks.js";
import type { BoneCornerBox } from "../mesh/aabb-corners.js";
import { buildSkinnedBoneCorners, growCornersByMatrix } from "../mesh/aabb-corners.js";
import { _casterAabb } from "./caster-world-aabb.js";

// Per-bone bind-space corner boxes for skinned casters, built once from static bind
// data (positions/joints/weights/morph deltas never change) and reused every frame.
// `null` marks a mesh with a skeleton but no usable geometry so it is not rebuilt.
// Lazy-initialized per GUIDANCE (no module-level WeakMap allocation).
interface BoneCornerCacheEntry {
    positions: Float32Array | undefined;
    boundMin: unknown;
    boundMax: unknown;
    skeleton: Mesh["skeleton"];
    joints: Uint8Array | Uint16Array;
    weights: Float32Array;
    joints1: Uint8Array | Uint16Array | null;
    weights1: Float32Array | null;
    morphTargets: Mesh["morphTargets"];
    morphTargetsArray: NonNullable<Mesh["morphTargets"]>["targets"] | undefined;
    boxes: BoneCornerBox[] | null;
}

let _boneCornerCache: WeakMap<Mesh, BoneCornerCacheEntry> | null = null;

// Scratch skinning matrix (`worldMatrix · boneMatrices[bone]`), reused per call.
const _skinMatrix = new F32(16);

function notifyShadowCasterChanged(data: SkeletonData | MorphTargetData | undefined): void {
    if (data) {
        data._shadowVersion = (data._shadowVersion ?? 0) + 1;
    }
}

/** Install posed bounds and invalidation for skinned shadow casters. */
export function enable(casterMeshes: readonly Mesh[]): void {
    for (const mesh of casterMeshes) {
        const skeleton = mesh.skeleton;
        if (skeleton && skeleton.weights && skeleton.boneMatrices) {
            skeleton._shadowVersion ??= 1;
        }
    }
    _installDeformationChangeNotifier(notifyShadowCasterChanged);
    _casterAabb[0] = skinnedCasterAabb;
}

/** World-space AABB of a skinned caster at its current pose, or `null` when the
 *  mesh is not skinned / has no usable geometry. Each influencing bone's bind-space
 *  corner box (cached) is folded through `worldMatrix · boneMatrices[bone]` — the
 *  exact skinning transform the depth pass rasterizes — so the frustum tracks the
 *  posed geometry as the skeleton animates or sweeps the mesh across the scene. */
function skinnedCasterAabb(mesh: Mesh): Aabb | null {
    const skeleton = mesh.skeleton;
    if (!skeleton || !skeleton.weights || !skeleton.boneMatrices) {
        return null;
    }
    const cache = (_boneCornerCache ??= new WeakMap<Mesh, BoneCornerCacheEntry>());
    const cached = cache.get(mesh);
    const morphTargets = mesh.morphTargets;
    const valid =
        cached &&
        cached.positions === mesh._cpuPositions &&
        cached.boundMin === mesh.boundMin &&
        cached.boundMax === mesh.boundMax &&
        cached.skeleton === skeleton &&
        cached.joints === skeleton.joints &&
        cached.weights === skeleton.weights &&
        cached.joints1 === skeleton.joints1 &&
        cached.weights1 === skeleton.weights1 &&
        cached.morphTargets === morphTargets &&
        cached.morphTargetsArray === morphTargets?.targets;
    const boneBoxes = valid ? cached.boxes : buildSkinnedBoneCorners(mesh);
    if (!valid) {
        cache.set(mesh, {
            positions: mesh._cpuPositions,
            boundMin: mesh.boundMin,
            boundMax: mesh.boundMax,
            skeleton,
            joints: skeleton.joints,
            weights: skeleton.weights,
            joints1: skeleton.joints1,
            weights1: skeleton.weights1,
            morphTargets,
            morphTargetsArray: morphTargets?.targets,
            boxes: boneBoxes,
        });
    }
    if (!boneBoxes) {
        return null;
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const world = mesh.worldMatrix as unknown as Mat4Storage;
    const boneMatrices = skeleton.boneMatrices;
    for (const box of boneBoxes) {
        mat4MultiplyInto(_skinMatrix, 0, world, 0, boneMatrices, box.boneIndex * 16);
        growCornersByMatrix(box.corners, _skinMatrix, min, max);
    }
    return Number.isFinite(min[0]) ? [min, max] : null;
}
