/** World AABB of a mesh, composed the same way the shaders draw it.
 *
 *  `Mesh.boundMin`/`boundMax` are OBJECT-LOCAL (see the declaration in mesh.ts), so anything that wants a
 *  world box has to apply `worldMatrix` — and, for a thin-instanced mesh, each instance matrix as well
 *  (`finalWorld = mesh.world × instanceMatrix`, per thin-instance-fragment). Framing/sizing helpers share
 *  this so they cannot drift from the render path or from the shadow fit.
 *
 *  This is the simple uncached form, meant for one-shot setup work (default camera, environment sizing).
 *  The per-frame shadow path keeps its own instance-versioned cache in csm-shadow-task-hooks. */

import type { Mesh } from "./mesh.js";

/** Mutable world-AABB accumulator. Seed with `emptyWorldAabb()`. */
export interface WorldAabbAcc {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

/** Accumulator containing no points; `minX` stays non-finite until something is added. */
export function emptyWorldAabb(): WorldAabbAcc {
    return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

function addRange(acc: WorldAabbAcc, axis: number, center: number, radius: number): void {
    const min = center - radius;
    const max = center + radius;
    const minKey = axis === 0 ? "minX" : axis === 1 ? "minY" : "minZ";
    const maxKey = axis === 0 ? "maxX" : axis === 1 ? "maxY" : "maxZ";
    if (min < acc[minKey]) {
        acc[minKey] = min;
    }
    if (max > acc[maxKey]) {
        acc[maxKey] = max;
    }
}

/** Expand `acc` by every corner of `mesh`'s local bounds taken through `mesh.worldMatrix`, and through each
 *  thin-instance matrix when the mesh carries instances. Meshes without bounds contribute nothing. */
export function expandWorldAabbForMesh(acc: WorldAabbAcc, mesh: Mesh): void {
    const bmin = mesh.boundMin;
    const bmax = mesh.boundMax;
    if (!bmin || !bmax) {
        return;
    }
    if (mesh._expandWorldBounds !== undefined) {
        mesh._expandWorldBounds(acc, mesh);
        return;
    }
    const world = mesh.worldMatrix;
    const center = [(bmin[0]! + bmax[0]!) * 0.5, (bmin[1]! + bmax[1]!) * 0.5, (bmin[2]! + bmax[2]!) * 0.5];
    const extent = [(bmax[0]! - bmin[0]!) * 0.5, (bmax[1]! - bmin[1]!) * 0.5, (bmax[2]! - bmin[2]!) * 0.5];
    for (let row = 0; row < 3; row++) {
        let transformedCenter = world[12 + row]!;
        let transformedRadius = 0;
        for (let column = 0; column < 3; column++) {
            const coefficient = world[column * 4 + row]!;
            transformedCenter += coefficient * center[column]!;
            transformedRadius += Math.abs(coefficient) * extent[column]!;
        }
        addRange(acc, row, transformedCenter, transformedRadius);
    }
}
