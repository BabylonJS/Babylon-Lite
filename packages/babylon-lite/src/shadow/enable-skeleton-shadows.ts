import type { Aabb } from "../math/aabb.js";
import type { BoneCornerBox } from "../mesh/aabb-corners.js";
import { buildSkinnedBoneCorners, growCornersByMatrix, setExtentCorners } from "../mesh/aabb-corners.js";
import type { Mesh } from "../mesh/mesh.js";
import { enableDeformableShadowBounds, getPreviousDeformableShadowBounds } from "./deformable-shadow-casters.js";
import type { DeformableShadowBoundsProvider } from "./deformable-shadow-casters.js";
import type { ShadowGenerator } from "./shadow-generator.js";

interface SkeletonBoundsCache {
    positions: Float32Array | undefined;
    skeleton: Mesh["skeleton"];
    joints: Uint8Array | Uint16Array;
    weights: Float32Array;
    joints1: Uint8Array | Uint16Array | null;
    weights1: Float32Array | null;
    boxes: BoneCornerBox[] | null;
    base: Aabb | null;
    composedCorners: Float32Array;
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
        cache.weights1 === skeleton.weights1
    ) {
        return cache;
    }
    const boxes = buildSkinnedBoneCorners(mesh);
    const base: Aabb | null = boxes
        ? [
              [Infinity, Infinity, Infinity],
              [-Infinity, -Infinity, -Infinity],
          ]
        : null;
    for (const box of boxes ?? []) {
        for (let axis = 0; axis < 3; axis++) {
            base![0][axis] = Math.min(base![0][axis]!, box.corners[axis]!);
            base![1][axis] = Math.max(base![1][axis]!, box.corners[21 + axis]!);
        }
    }
    const next: SkeletonBoundsCache = {
        positions: mesh._cpuPositions,
        skeleton,
        joints: skeleton.joints,
        weights: skeleton.weights,
        joints1: skeleton.joints1,
        weights1: skeleton.weights1,
        boxes,
        base,
        composedCorners: new Float32Array(24),
        result: [
            [0, 0, 0],
            [0, 0, 0],
        ],
    };
    caches.set(mesh, next);
    return next;
}

function createSkeletonBoundsProvider(generator: ShadowGenerator): DeformableShadowBoundsProvider {
    return {
        kind: "skeleton",
        applies: (mesh) => !!mesh.skeleton?.weights && !!mesh.skeleton.boneMatrices,
        getLocalBounds(mesh) {
            const bounds = getPreviousDeformableShadowBounds(generator, mesh, "skeleton");
            const cache = getCache(mesh);
            const boneMatrices = mesh.skeleton?.boneMatrices;
            if (!cache?.boxes || !boneMatrices) {
                return bounds;
            }
            const min = cache.result[0];
            const max = cache.result[1];
            if (bounds && cache.base) {
                for (let axis = 0; axis < 3; axis++) {
                    min[axis] = Math.min(bounds[0][axis]!, cache.base[0][axis]!);
                    max[axis] = Math.max(bounds[1][axis]!, cache.base[1][axis]!);
                }
                setExtentCorners(cache.composedCorners, min, max);
            }
            min[0] = min[1] = min[2] = Infinity;
            max[0] = max[1] = max[2] = -Infinity;
            for (const box of cache.boxes) {
                growCornersByMatrix(bounds ? cache.composedCorners : box.corners, boneMatrices, min, max, box.boneIndex * 16);
            }
            return Number.isFinite(min[0]) ? cache.result : bounds;
        },
    };
}

/** Enable live skeletal bounds for one shadow generator. */
export function enableSkeletonShadows(generator: ShadowGenerator): void {
    enableDeformableShadowBounds(generator, createSkeletonBoundsProvider(generator));
}
