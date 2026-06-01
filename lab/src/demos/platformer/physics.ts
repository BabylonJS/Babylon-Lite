/**
 * Swept axis-aligned bounding-box (AABB) collision against the tile grid.
 *
 * The engine ships no 2D physics, so this is a small clean-room tile collider:
 * resolve the X axis then the Y axis independently, scanning only the tile cells
 * the moving box overlaps. Coordinates are world pixels with `(x, y)` at the box's
 * top-left and y pointing down.
 */

import { TILE } from "./frames.js";

export interface AABB {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** A solidity oracle over the tile grid. */
export interface CollisionMap {
    cols: number;
    rows: number;
    /** True if the tile cell `(cx, cy)` blocks movement. */
    isSolid: (cx: number, cy: number) => boolean;
}

export interface MoveResult {
    onGround: boolean;
    hitCeiling: boolean;
    hitWall: -1 | 0 | 1;
    /** Tile cell directly bumped from below this step, or null (for ?-block / brick hits). */
    ceilingCell: { cx: number; cy: number } | null;
}

const cellOf = (px: number): number => Math.floor(px / TILE);

/**
 * Integrate `box` by velocity `(vx, vy) * dt`, resolving against solid tiles.
 * Mutates `box` in place and returns the resolved velocity plus contact flags.
 */
export function moveAndCollide(box: AABB, vx: number, vy: number, dt: number, map: CollisionMap): { vx: number; vy: number } & MoveResult {
    const result: { vx: number; vy: number } & MoveResult = {
        vx,
        vy,
        onGround: false,
        hitCeiling: false,
        hitWall: 0,
        ceilingCell: null,
    };

    // ── X axis ──────────────────────────────────────────────────────────────
    const dx = vx * dt;
    box.x += dx;
    if (dx !== 0) {
        const dir = dx > 0 ? 1 : -1;
        const probeX = dir > 0 ? box.x + box.w : box.x;
        const cx = cellOf(probeX);
        const y0 = cellOf(box.y + 0.001);
        const y1 = cellOf(box.y + box.h - 0.001);
        for (let cy = y0; cy <= y1; cy++) {
            if (map.isSolid(cx, cy)) {
                box.x = dir > 0 ? cx * TILE - box.w : (cx + 1) * TILE;
                result.vx = 0;
                result.hitWall = dir;
                break;
            }
        }
    }

    // ── Y axis ──────────────────────────────────────────────────────────────
    const dy = vy * dt;
    box.y += dy;
    if (dy !== 0) {
        const dir = dy > 0 ? 1 : -1;
        const probeY = dir > 0 ? box.y + box.h : box.y;
        const cy = cellOf(probeY);
        const x0 = cellOf(box.x + 0.001);
        const x1 = cellOf(box.x + box.w - 0.001);
        for (let cx = x0; cx <= x1; cx++) {
            if (map.isSolid(cx, cy)) {
                if (dir > 0) {
                    box.y = cy * TILE - box.h;
                    result.onGround = true;
                } else {
                    box.y = (cy + 1) * TILE;
                    result.hitCeiling = true;
                    result.ceilingCell = { cx, cy };
                }
                result.vy = 0;
                break;
            }
        }
    }

    return result;
}

/** True if two AABBs overlap (touching edges do not count). */
export function overlaps(a: AABB, b: AABB): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
