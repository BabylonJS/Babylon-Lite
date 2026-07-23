import type { Aabb } from "../math/aabb.js";
import type { BoneCornerBox } from "../mesh/aabb-corners.js";
import { buildSkinnedBoneCorners, growCornersByMatrix } from "../mesh/aabb-corners.js";
import type { Mesh } from "../mesh/mesh.js";
import { enableDeformableShadowBounds, type DeformableShadowBoundsProvider } from "./deformable-shadow-casters.js";
import type { ShadowGenerator } from "./shadow-generator.js";

interface SkeletonBoundsCache {
    positions: Float32Array | undefined;
    skeleton: Mesh["skeleton"];
    joints: Uint8Array | Uint16Array;
    weights: Float32Array;
    joints1: Uint8Array | Uint16Array | null;
    weights1: Float32Array | null;
    morphTargets: Mesh["morphTargets"];
    targets: NonNullable<Mesh["morphTargets"]>["targets"] | undefined;
    boxes: BoneCornerBox[] | null;
    result: Aabb;
}

let caches: WeakMap<Mesh, SkeletonBoundsCache> | null = null;

function getCache(mesh: Mesh): SkeletonBoundsCache | null {
    const skeleton = mesh.skeleton;
    if (!skeleton?.weights || !skeleton.boneMatrices) {
        return null;
    }
    const cache = (caches ??= new WeakMap()).get(mesh);
    if (
        cache &&
        cache.positions === mesh._cpuPositions &&
        cache.skeleton === skeleton &&
        cache.joints === skeleton.joints &&
        cache.weights === skeleton.weights &&
        cache.joints1 === skeleton.joints1 &&
        cache.weights1 === skeleton.weights1 &&
        cache.morphTargets === mesh.morphTargets &&
        cache.targets === mesh.morphTargets?.targets
    ) {
        return cache;
    }
    const next: SkeletonBoundsCache = {
        positions: mesh._cpuPositions,
        skeleton,
        joints: skeleton.joints,
        weights: skeleton.weights,
        joints1: skeleton.joints1,
        weights1: skeleton.weights1,
        morphTargets: mesh.morphTargets,
        targets: mesh.morphTargets?.targets,
        boxes: buildSkinnedBoneCorners(mesh),
        result: [
            [0, 0, 0],
            [0, 0, 0],
        ],
    };
    caches.set(mesh, next);
    return next;
}

const skeletonBoundsProvider: DeformableShadowBoundsProvider = {
    kind: 0,
    applies: (mesh) => !!mesh.skeleton?.weights && !!mesh.skeleton.boneMatrices,
    getLocalBounds(mesh) {
        const cache = getCache(mesh);
        const boneMatrices = mesh.skeleton?.boneMatrices;
        if (!cache?.boxes || !boneMatrices) {
            return null;
        }
        const min = cache.result[0];
        const max = cache.result[1];
        min[0] = min[1] = min[2] = Infinity;
        max[0] = max[1] = max[2] = -Infinity;
        for (const box of cache.boxes) {
            growCornersByMatrix(box.corners, boneMatrices, min, max, box.boneIndex * 16);
        }
        return Number.isFinite(min[0]) ? cache.result : null;
    },
};

/** Enable live skeletal bounds for one shadow generator. */
export function enableSkeletonShadows(generator: ShadowGenerator): void {
    enableDeformableShadowBounds(generator, skeletonBoundsProvider);
}
