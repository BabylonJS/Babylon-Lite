// Shared BSP point-location queries used by the camera, mobjs and specials.
//
// Walks the node tree to find the subsector (and thus sector) containing a map
// point, following the documented Doom convention: at each node, the cross
// product of the partition line with the point selects the right (front) or
// left (back) child; NF_SUBSECTOR marks a leaf.

import type { DoomMap } from "./map.js";
import { NF_SUBSECTOR } from "./map.js";

/** Returns the sector index containing (x, y), or -1 if it cannot be resolved. */
export function sectorIndexAt(map: DoomMap, x: number, y: number): number {
    if (map.nodes.length === 0) return -1;
    let ref = map.nodes.length - 1;
    while (!(ref & NF_SUBSECTOR)) {
        const node = map.nodes[ref];
        if (!node) return -1;
        const s = node.dx * (y - node.y) - node.dy * (x - node.x);
        ref = s <= 0 ? node.rightChild : node.leftChild;
    }
    const ss = map.subsectors[ref & ~NF_SUBSECTOR];
    if (!ss) return -1;
    const seg = map.segs[ss.firstSeg];
    if (!seg) return -1;
    const ld = map.linedefs[seg.linedef];
    if (!ld) return -1;
    const sideRef = seg.side === 0 ? ld.front : ld.back;
    if (sideRef < 0) return -1;
    const side = map.sidedefs[sideRef];
    return side ? side.sector : -1;
}

/** Floor height of the sector containing (x, y), or 0 if unresolved. */
export function floorHeightAt(map: DoomMap, x: number, y: number): number {
    const sec = sectorIndexAt(map, x, y);
    return sec < 0 ? 0 : (map.sectors[sec]?.floorHeight ?? 0);
}

/** Ceiling height of the sector containing (x, y), or 0 if unresolved. */
export function ceilingHeightAt(map: DoomMap, x: number, y: number): number {
    const sec = sectorIndexAt(map, x, y);
    return sec < 0 ? 0 : (map.sectors[sec]?.ceilHeight ?? 0);
}
