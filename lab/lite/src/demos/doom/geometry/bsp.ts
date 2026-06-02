// Builds gap-free convex floor/ceiling polygons for every subsector by walking
// the BSP and clipping a map-bounds quad against each node's partition half-plane.
//
// Classic Doom subsectors are convex but their segs only cover linedef-derived
// edges; the implicit edges come from the BSP partition lines. Clipping a large
// quad down through the traversal recovers the full convex region with no gaps.

import type { DoomMap } from "../wad/map.js";
import { NF_SUBSECTOR } from "../wad/map.js";

export interface Pt {
    x: number;
    y: number;
}

const EPS = 1e-4;

/** Returns one convex polygon (Doom XY, CCW-or-CW as produced) per subsector. */
export function buildSubsectorPolygons(map: DoomMap): (Pt[] | null)[] {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const v of map.vertices) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
    }
    const m = 8;
    const rootQuad: Pt[] = [
        { x: minX - m, y: minY - m },
        { x: maxX + m, y: minY - m },
        { x: maxX + m, y: maxY + m },
        { x: minX - m, y: maxY + m },
    ];

    const out: (Pt[] | null)[] = new Array(map.subsectors.length).fill(null);
    if (map.nodes.length === 0) return out;

    const visit = (childRef: number, poly: Pt[]): void => {
        if (poly.length < 3) return;
        if (childRef & NF_SUBSECTOR) {
            const ssIndex = childRef & ~NF_SUBSECTOR;
            if (ssIndex < out.length) out[ssIndex] = poly;
            return;
        }
        const node = map.nodes[childRef];
        if (!node) return;
        // Right child keeps the s<=0 half-plane, left child keeps s>=0.
        visit(node.rightChild, clipHalfPlane(poly, node.x, node.y, node.dx, node.dy, true));
        visit(node.leftChild, clipHalfPlane(poly, node.x, node.y, node.dx, node.dy, false));
    };

    visit(map.nodes.length - 1, rootQuad);
    return out;
}

function signed(px: number, py: number, dx: number, dy: number, qx: number, qy: number): number {
    return dx * (qy - py) - dy * (qx - px);
}

/** Sutherland-Hodgman clip of a convex polygon against one partition half-plane. */
function clipHalfPlane(poly: Pt[], px: number, py: number, dx: number, dy: number, keepRight: boolean): Pt[] {
    const result: Pt[] = [];
    const inside = (s: number): boolean => (keepRight ? s <= EPS : s >= -EPS);
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        const sa = signed(px, py, dx, dy, a.x, a.y);
        const sb = signed(px, py, dx, dy, b.x, b.y);
        const ina = inside(sa);
        const inb = inside(sb);
        if (ina) result.push(a);
        if (ina !== inb) {
            const t = sa / (sa - sb);
            result.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
        }
    }
    return dedupe(result);
}

function dedupe(poly: Pt[]): Pt[] {
    if (poly.length < 2) return poly;
    const out: Pt[] = [];
    for (const p of poly) {
        const last = out[out.length - 1];
        if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) out.push(p);
    }
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length > 1 && first && last && Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS) {
        out.pop();
    }
    return out;
}

/** Signed area in the XY plane (>0 CCW). Used to normalize floor/ceiling winding. */
export function signedArea(poly: Pt[]): number {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i]!;
        const q = poly[(i + 1) % poly.length]!;
        a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
}
