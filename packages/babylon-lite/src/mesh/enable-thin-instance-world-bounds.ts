/** Opt-in setup-time world bounds for hand-built thin-instance meshes. */

import type { Mesh } from "./mesh.js";
import type { WorldAabbAcc } from "./mesh-world-bounds.js";

function expandThinInstanceWorldBounds(bounds: WorldAabbAcc, mesh: Mesh): void {
    const boundMin = mesh.boundMin!;
    const boundMax = mesh.boundMax!;
    const world = mesh.worldMatrix;
    const thinInstances = mesh.thinInstances!;
    const matrices = thinInstances.matrices;
    const count = Math.min(thinInstances.count, (matrices.length / 16) | 0);
    const center = [(boundMin[0] + boundMax[0]) * 0.5, (boundMin[1] + boundMax[1]) * 0.5, (boundMin[2] + boundMax[2]) * 0.5];
    const extent = [(boundMax[0] - boundMin[0]) * 0.5, (boundMax[1] - boundMin[1]) * 0.5, (boundMax[2] - boundMin[2]) * 0.5];

    for (let instanceIndex = 0; instanceIndex < count; instanceIndex++) {
        const matrixOffset = instanceIndex * 16;
        let linearSize = 0;
        for (let row = 0; row < 3; row++) {
            for (let column = 0; column < 3; column++) {
                linearSize += Math.abs(matrices[matrixOffset + column * 4 + row]!);
            }
        }
        if (linearSize < 1e-9) {
            continue;
        }

        for (let row = 0; row < 3; row++) {
            let transformedCenter = world[12 + row]!;
            let transformedRadius = 0;
            for (let column = 0; column < 3; column++) {
                let coefficient = 0;
                for (let inner = 0; inner < 3; inner++) {
                    coefficient += world[inner * 4 + row]! * matrices[matrixOffset + column * 4 + inner]!;
                }
                transformedCenter += coefficient * center[column]!;
                transformedRadius += Math.abs(coefficient) * extent[column]!;
            }
            for (let inner = 0; inner < 3; inner++) {
                transformedCenter += world[inner * 4 + row]! * matrices[matrixOffset + 12 + inner]!;
            }

            const min = transformedCenter - transformedRadius;
            const max = transformedCenter + transformedRadius;
            const minKey = row === 0 ? "minX" : row === 1 ? "minY" : "minZ";
            const maxKey = row === 0 ? "maxX" : row === 1 ? "maxY" : "maxZ";
            if (min < bounds[minKey]) {
                bounds[minKey] = min;
            }
            if (max > bounds[maxKey]) {
                bounds[maxKey] = max;
            }
        }
    }
}

/** Enable exact `worldMatrix × instanceMatrix × localBounds` setup-time bounds for a thin-instance mesh. */
export function enableThinInstanceWorldBounds(mesh: Mesh): void {
    if (!mesh.thinInstances) {
        throw new Error("enableThinInstanceWorldBounds requires mesh.thinInstances");
    }
    mesh._expandWorldBounds = expandThinInstanceWorldBounds;
}
