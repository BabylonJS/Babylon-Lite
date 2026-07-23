import type { MorphTargetData } from "../animation/types.js";
import type { Aabb } from "../math/aabb.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import { enableDeformableShadowBounds } from "./deformable-shadow-casters.js";
import type { DeformableShadowBoundsProvider } from "./deformable-shadow-casters.js";
import type { ShadowGenerator } from "./shadow-generator.js";

interface MorphBoundsCache {
    positions: Float32Array | undefined;
    base: Aabb | null;
    morphTargets: MorphTargetData;
    targets: MorphTargetData["targets"];
    targetRanges: readonly Aabb[];
    result: Aabb;
}

let caches: WeakMap<Mesh, MorphBoundsCache> | null = null;

function createCache(mesh: Mesh, morphTargets: MorphTargetData): MorphBoundsCache {
    const positions = mesh._cpuPositions;
    const base: Aabb | null = positions?.length ? computeAabb(positions) : mesh.boundMin && mesh.boundMax ? [mesh.boundMin, mesh.boundMax] : null;
    return {
        positions,
        base,
        morphTargets,
        targets: morphTargets.targets,
        targetRanges: morphTargets.targets.map((target) => computeAabb(target.positions)),
        result: [
            [0, 0, 0],
            [0, 0, 0],
        ],
    };
}

function getCache(mesh: Mesh, morphTargets: MorphTargetData): MorphBoundsCache {
    const cache = (caches ??= new WeakMap()).get(mesh);
    if (cache && cache.positions === mesh._cpuPositions && cache.morphTargets === morphTargets && cache.targets === morphTargets.targets) {
        return cache;
    }
    const next = createCache(mesh, morphTargets);
    caches.set(mesh, next);
    return next;
}

const morphBoundsProvider: DeformableShadowBoundsProvider = {
    kind: "morph",
    applies: (mesh) => !!mesh.morphTargets,
    getLocalBounds(mesh) {
        const morphTargets = mesh.morphTargets;
        if (!morphTargets) {
            return null;
        }
        const cache = getCache(mesh, morphTargets);
        if (!cache.base) {
            return null;
        }
        const min = cache.result[0];
        const max = cache.result[1];
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = cache.base[0][axis]!;
            max[axis] = cache.base[1][axis]!;
        }
        for (let target = 0; target < morphTargets.count; target++) {
            const range = cache.targetRanges[target];
            const weight = morphTargets.weights[target] ?? 0;
            if (!range || !weight) {
                continue;
            }
            const targetMin = weight < 0 ? range[1] : range[0];
            const targetMax = weight < 0 ? range[0] : range[1];
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = min[axis]! + targetMin[axis]! * weight;
                max[axis] = max[axis]! + targetMax[axis]! * weight;
            }
        }
        return cache.result;
    },
};

/** Enable live morph-target bounds for one shadow generator. */
export function enableMorphTargetShadows(generator: ShadowGenerator): void {
    enableDeformableShadowBounds(generator, morphBoundsProvider);
}
