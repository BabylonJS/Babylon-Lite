// Morph-only shadow-caster bounds live in their own optional module so scenes that
// animate morph weights do not fetch skeletal corner construction or bone-matrix math.

import type { Aabb } from "../math/aabb.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MorphTargetData, SkeletonData } from "../animation/types.js";
import { _installDeformationChangeNotifier } from "../animation/deformation-change-hooks.js";
import { _casterAabb } from "./caster-world-aabb.js";

const _localAabb: Aabb = [
    [0, 0, 0],
    [0, 0, 0],
];

function notifyShadowCasterChanged(data: SkeletonData | MorphTargetData | undefined): void {
    if (data) {
        data._shadowVersion = (data._shadowVersion ?? 0) + 1;
    }
}

/** Install active morph bounds and invalidation for the supplied shadow casters. */
export function enable(casterMeshes: readonly Mesh[]): void {
    for (const mesh of casterMeshes) {
        const morphTargets = mesh.morphTargets;
        if (morphTargets && morphTargets._shadowVersion === undefined) {
            morphTargets._shadowVersion = 1;
        }
    }
    _installDeformationChangeNotifier(notifyShadowCasterChanged);
    _casterAabb[1] = morphCasterLocalAabb;
}

export function morphCasterLocalAabb(mesh: Mesh): Aabb | null {
    const morphTargets = mesh.morphTargets;
    const base = mesh._localBounds;
    if (!base || !morphTargets) {
        return null;
    }
    const min = _localAabb[0];
    const max = _localAabb[1];
    for (let axis = 0; axis < 3; axis++) {
        min[axis] = base[0][axis]!;
        max[axis] = base[1][axis]!;
    }
    for (let target = 0; target < morphTargets.count; target++) {
        const morphTarget = morphTargets.targets[target]!;
        const deltas = morphTarget.positions;
        const range = (morphTarget._shadowDeltaRange ??= computeAabb(deltas));
        const weight = morphTargets.weights[target] ?? 0;
        // Multiplying an interval by a negative weight reverses its endpoints.
        const order = weight < 0 ? 1 : 0;
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = min[axis]! + range[order]![axis]! * weight;
            max[axis] = max[axis]! + range[1 - order]![axis]! * weight;
        }
    }
    return _localAabb;
}
