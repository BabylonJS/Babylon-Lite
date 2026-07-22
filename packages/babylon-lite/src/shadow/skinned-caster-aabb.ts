// Deformable shadow-caster world AABBs, split into their own module so static
// shadow scenes never pay for active morph or per-bone corner math.

import { F32 } from "../engine/typed-arrays.js";
import { _installDeformationChangeNotifier } from "../animation/deformation-change-hooks.js";
import type { MorphTargetData, SkeletonData } from "../animation/types.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";
import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import type { BoneCornerBox } from "../mesh/aabb-corners.js";
import { buildSkinnedBoneCorners, extentCorners, growCornersByMatrix } from "../mesh/aabb-corners.js";
import { _installDeformedCasterAabb, _localCasterAabb } from "./caster-world-aabb.js";

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

// Morph bounds have two cache tiers: geometry/target references guard the O(vertices x
// targets) delta-range build, while weights plus _shadowVersion guard the O(targets)
// pose update. Normal animation therefore never rescans the vertex buffers.
interface MorphAabbCacheEntry {
    positions: Float32Array;
    boundMin: unknown;
    boundMax: unknown;
    morphTargets: NonNullable<Mesh["morphTargets"]>;
    targets: NonNullable<Mesh["morphTargets"]>["targets"];
    targetPositions: (Float32Array | undefined)[];
    deltaRanges: Float32Array;
    weights: Float32Array;
    version: number;
    base: Aabb;
    local: Aabb;
}

let _morphAabbCache: WeakMap<Mesh, MorphAabbCacheEntry> | null = null;

// Scratch skinning matrix (`worldMatrix · boneMatrices[bone]`), reused per call.
const _skinMatrix = new F32(16);

type DeformationData = SkeletonData | MorphTargetData;

function installShadowChangeHook(data: DeformationData): void {
    if (data._onShadowCasterChanged) {
        return;
    }
    let poseTokens: WeakMap<object, number> | undefined;
    data._shadowVersion = 0;
    data._onShadowCasterChanged = (source?: object, poseToken?: number): void => {
        // Shared deformation data can be reached through several bindings of one
        // controller. Deduplicate that controller/time pair, but clear the tokens for
        // unkeyed manual or masked updates because they may change a fixed-time pose.
        if (source && poseToken !== undefined) {
            const previous = poseTokens?.get(source);
            if (previous === poseToken) {
                return;
            }
            (poseTokens ??= new WeakMap()).set(source, poseToken);
        } else {
            poseTokens = undefined;
        }
        data._shadowVersion = (data._shadowVersion ?? 0) + 1;
    };
}

function notifyShadowCasterChanged(data: DeformationData | undefined, source?: object, poseToken?: number): void {
    data?._onShadowCasterChanged?.(source, poseToken);
}

/** Install posed bounds and invalidation for skinned or morphed shadow casters. */
export function enableDeformableCasterAabb(casterMeshes: readonly Mesh[]): void {
    for (const mesh of casterMeshes) {
        const skeleton = mesh.skeleton;
        const morphTargets = mesh.morphTargets;
        if (skeleton && skeleton.weights && skeleton.boneMatrices) {
            installShadowChangeHook(skeleton);
        }
        if (morphTargets) {
            installShadowChangeHook(morphTargets);
        }
    }
    // Animation writers call the null-by-default bridge; this optional chunk owns the
    // concrete hook and the version state it updates.
    _installDeformationChangeNotifier(notifyShadowCasterChanged);
    _installDeformedCasterAabb(deformedCasterAabb, morphCasterLocalAabb);
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

export function morphCasterLocalAabb(mesh: Mesh): Aabb | null {
    const positions = mesh._cpuPositions;
    const morphTargets = mesh.morphTargets;
    if (!positions || positions.length < 3 || !morphTargets) {
        return null;
    }
    const cache = (_morphAabbCache ??= new WeakMap<Mesh, MorphAabbCacheEntry>());
    const version = morphTargets._shadowVersion ?? 0;
    let cached = cache.get(mesh);
    if (
        cached &&
        (cached.positions !== positions ||
            cached.boundMin !== mesh.boundMin ||
            cached.boundMax !== mesh.boundMax ||
            cached.morphTargets !== morphTargets ||
            cached.targets !== morphTargets.targets ||
            cached.targetPositions.length !== morphTargets.count)
    ) {
        cached = undefined;
    }
    if (cached) {
        // The target list is readonly by contract, but compare nested position-array
        // references as well so replacing imported geometry rebuilds the ranges.
        for (let target = 0; target < morphTargets.count; target++) {
            if (cached.targetPositions[target] !== morphTargets.targets[target]?.positions) {
                cached = undefined;
                break;
            }
        }
    }
    if (!cached) {
        const base = _localCasterAabb(mesh, positions);
        if (!base) {
            return null;
        }
        const vertexCount = (positions.length / 3) | 0;
        const targetPositions = new Array<Float32Array | undefined>(morphTargets.count);
        const deltaRanges = new F32(morphTargets.count * 6);
        // Cache one XYZ delta interval per target. Combining signed weighted intervals
        // is conservative for stacked targets and removes vertex count from pose updates.
        for (let target = 0; target < morphTargets.count; target++) {
            const deltas = morphTargets.targets[target]?.positions;
            targetPositions[target] = deltas;
            const rangeOffset = target * 6;
            let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            for (let vertex = 0; vertex < vertexCount; vertex++) {
                const offset = vertex * 3;
                const x = deltas && offset + 2 < deltas.length ? deltas[offset]! : 0;
                const y = deltas && offset + 2 < deltas.length ? deltas[offset + 1]! : 0;
                const z = deltas && offset + 2 < deltas.length ? deltas[offset + 2]! : 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                minZ = Math.min(minZ, z);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                maxZ = Math.max(maxZ, z);
            }
            deltaRanges[rangeOffset] = minX;
            deltaRanges[rangeOffset + 1] = minY;
            deltaRanges[rangeOffset + 2] = minZ;
            deltaRanges[rangeOffset + 3] = maxX;
            deltaRanges[rangeOffset + 4] = maxY;
            deltaRanges[rangeOffset + 5] = maxZ;
        }
        cached = {
            positions,
            boundMin: mesh.boundMin,
            boundMax: mesh.boundMax,
            morphTargets,
            targets: morphTargets.targets,
            targetPositions,
            deltaRanges,
            weights: morphTargets.weights,
            version: -1,
            base,
            local: [
                [0, 0, 0],
                [0, 0, 0],
            ],
        };
        cache.set(mesh, cached);
    }
    if (cached.weights !== morphTargets.weights || cached.version !== version) {
        // Weight-only animation starts from the cached base box and combines one signed
        // delta interval per target: O(targets), with no vertex-buffer reads.
        const min = cached.local[0];
        const max = cached.local[1];
        min[0] = cached.base[0][0];
        min[1] = cached.base[0][1];
        min[2] = cached.base[0][2];
        max[0] = cached.base[1][0];
        max[1] = cached.base[1][1];
        max[2] = cached.base[1][2];
        for (let target = 0; target < morphTargets.count; target++) {
            const weight = morphTargets.weights[target] ?? 0;
            const rangeOffset = target * 6;
            // Multiplying an interval by a negative weight reverses its endpoints.
            const minOffset = weight < 0 ? rangeOffset + 3 : rangeOffset;
            const maxOffset = weight < 0 ? rangeOffset : rangeOffset + 3;
            min[0] += cached.deltaRanges[minOffset]! * weight;
            min[1] += cached.deltaRanges[minOffset + 1]! * weight;
            min[2] += cached.deltaRanges[minOffset + 2]! * weight;
            max[0] += cached.deltaRanges[maxOffset]! * weight;
            max[1] += cached.deltaRanges[maxOffset + 1]! * weight;
            max[2] += cached.deltaRanges[maxOffset + 2]! * weight;
        }
        cached.weights = morphTargets.weights;
        cached.version = version;
    }
    return Number.isFinite(cached.local[0][0]) ? cached.local : null;
}

function morphCasterAabb(mesh: Mesh): Aabb | null {
    const local = morphCasterLocalAabb(mesh);
    if (!local) {
        return null;
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    growCornersByMatrix(extentCorners(local[0], local[1]), mesh.worldMatrix, min, max);
    return [min, max];
}

/** World-space bounds for the active skeletal or morph-only deformation. */
export function deformedCasterAabb(mesh: Mesh): Aabb | null {
    return skinnedCasterAabb(mesh) ?? morphCasterAabb(mesh);
}
