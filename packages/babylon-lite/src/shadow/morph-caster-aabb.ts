// Morph-only shadow-caster bounds live in their own optional module so scenes that
// animate morph weights do not fetch skeletal corner construction or bone-matrix math.

import { F32 } from "../engine/typed-arrays.js";
import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import { _installMorphCasterAabb, _localCasterAabb, _worldAabbFromLocalBounds } from "./caster-world-aabb.js";
import { enableDeformationCasterTracking } from "./deformation-caster-tracking.js";

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

/** Install active morph bounds and invalidation for the supplied shadow casters. */
export function enableMorphCasterAabb(casterMeshes: readonly Mesh[]): void {
    for (const mesh of casterMeshes) {
        if (mesh.morphTargets) {
            enableDeformationCasterTracking(mesh.morphTargets);
        }
    }
    _installMorphCasterAabb(morphCasterAabb, morphCasterLocalAabb);
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
    return local ? _worldAabbFromLocalBounds(local[0], local[1], mesh.worldMatrix) : null;
}
