// Amanatides & Woo voxel ray traversal for block selection. Walks the grid from
// the camera along the view direction, returning the first solid (selectable)
// block hit and the empty cell just before it (where a new block is placed).

import { Block, blockDef } from "./blocks.js";
import type { World } from "./world.js";

export interface RayHit {
    /** Coordinates of the solid block hit. */
    bx: number;
    by: number;
    bz: number;
    /** Empty cell adjacent to the hit face (placement target). */
    px: number;
    py: number;
    pz: number;
}

function selectable(id: number): boolean {
    if (id === Block.AIR) return false;
    const d = blockDef(id);
    // Don't select fluids — you reach through water to the bed below.
    return !!d && !d.fluid;
}

export function raycastVoxel(world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    const invX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    const invY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
    const invZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;

    // Distance to the first voxel boundary on each axis.
    let tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x) * invX) : Infinity;
    let tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y) * invY) : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z) * invZ) : Infinity;

    let px = x;
    let py = y;
    let pz = z;

    let t = 0;
    while (t <= maxDist) {
        if (selectable(world.getBlock(x, y, z))) {
            return { bx: x, by: y, bz: z, px, py, pz };
        }
        px = x;
        py = y;
        pz = z;
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
            x += stepX;
            t = tMaxX;
            tMaxX += invX;
        } else if (tMaxY < tMaxZ) {
            y += stepY;
            t = tMaxY;
            tMaxY += invY;
        } else {
            z += stepZ;
            t = tMaxZ;
            tMaxZ += invZ;
        }
    }
    return null;
}
