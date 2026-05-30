// Clean-room DOOM-style player collision, implemented from public descriptions of
// the engine's movement rules (Doom Wiki / Unofficial Doom Specs). No GPL Doom
// source is used or copied.
//
// Movement model (faithful subset):
//   - Player is a circle of radius 16 in the map plane.
//   - One-sided lines and ML_BLOCKING lines are always solid.
//   - Two-sided lines block when the vertical opening is shorter than the player
//     height (56), or when the far floor steps up more than 24 units.
//   - Collisions resolve by pushing the player out of the line along its normal,
//     which preserves tangential motion (wall sliding).

import type { DoomMap, Sector } from "../wad/map.js";

export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;
export const MAX_STEP = 24;
export const VIEW_HEIGHT = 41;

const ML_BLOCKING = 0x0001;
const ML_BLOCKMONSTERS = 0x0002;

export interface CollLine {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    oneSided: boolean;
    blocking: boolean;
    blockMonsters: boolean;
    /** Front/back sector indices; back is -1 for one-sided lines. */
    frontSec: number;
    backSec: number;
}

export interface MoveOpts {
    radius: number;
    height: number;
    maxStep: number;
    /** When true, ML_BLOCKMONSTERS lines also block this mover. */
    isMonster: boolean;
}

const PLAYER_MOVE: MoveOpts = { radius: PLAYER_RADIUS, height: PLAYER_HEIGHT, maxStep: MAX_STEP, isMonster: false };

export function buildCollisionLines(map: DoomMap): CollLine[] {
    const lines: CollLine[] = [];
    for (const ld of map.linedefs) {
        if (ld.front < 0) continue;
        const v1 = map.vertices[ld.start];
        const v2 = map.vertices[ld.end];
        if (!v1 || !v2) continue;
        const frontSec = map.sidedefs[ld.front]!.sector;
        if (map.sectors[frontSec] === undefined) continue;
        const oneSided = ld.back < 0;
        const backSec = oneSided ? -1 : map.sidedefs[ld.back]!.sector;

        lines.push({
            x1: v1.x,
            y1: v1.y,
            x2: v2.x,
            y2: v2.y,
            oneSided,
            blocking: (ld.flags & ML_BLOCKING) !== 0,
            blockMonsters: (ld.flags & ML_BLOCKMONSTERS) !== 0,
            frontSec,
            backSec,
        });
    }
    return lines;
}

// Live opening test against current sector heights, so doors/lifts that mutate
// sector floor/ceiling immediately affect passability.
function lineBlocks(line: CollLine, currentFloor: number, sectors: Sector[], opts: MoveOpts): boolean {
    if (line.oneSided || line.blocking) return true;
    if (opts.isMonster && line.blockMonsters) return true;
    const front = sectors[line.frontSec];
    const back = sectors[line.backSec];
    if (!front || !back) return true;
    const openTop = Math.min(front.ceilHeight, back.ceilHeight);
    const openBottom = Math.max(front.floorHeight, back.floorHeight);
    if (openTop - openBottom < opts.height) return true;
    if (openBottom - currentFloor > opts.maxStep) return true;
    return false;
}

/**
 * Resolves a desired move from (fromX,fromY) by (dx,dy) against blocking lines,
 * sliding along walls. `currentFloor` is the floor height the mover stands on.
 * `opts` defaults to the player's dimensions.
 */
export function tryMove(lines: CollLine[], fromX: number, fromY: number, dx: number, dy: number, currentFloor: number, sectors: Sector[], opts: MoveOpts = PLAYER_MOVE): { x: number; y: number } {
    let px = fromX + dx;
    let py = fromY + dy;
    const r2 = opts.radius * opts.radius;

    for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (const line of lines) {
            if (!lineBlocks(line, currentFloor, sectors, opts)) continue;
            // Extent gate: only react if the destination is near this segment.
            const cp = closestPointOnSegment(line, px, py);
            const gx = px - cp.x;
            const gy = py - cp.y;
            if (gx * gx + gy * gy >= r2) continue;

            // Resolve along the infinite line's normal, oriented toward the side the
            // mover came FROM, so fast moves can't tunnel to the far side.
            const lx = line.x2 - line.x1;
            const ly = line.y2 - line.y1;
            let nx = -ly;
            let ny = lx;
            const len = Math.hypot(nx, ny) || 1;
            nx /= len;
            ny /= len;
            const sFrom = (fromX - line.x1) * nx + (fromY - line.y1) * ny;
            if (sFrom < 0) {
                nx = -nx;
                ny = -ny;
            }
            const sDest = (px - line.x1) * nx + (py - line.y1) * ny;
            if (sDest < opts.radius) {
                const push = opts.radius - sDest;
                px += nx * push;
                py += ny * push;
                moved = true;
            }
        }
        if (!moved) break;
    }

    return { x: px, y: py };
}

export interface BlockThing {
    x: number;
    y: number;
    radius: number;
}

/**
 * Pushes a mover at (px,py) out of any solid thing it overlaps, mirroring the
 * wall resolver: the push is purely radial so tangential motion is preserved and
 * the mover slides around the obstacle. Faithful to vanilla Doom, where solid
 * things (monsters, barrels, columns) block movement and are effectively
 * infinitely tall for the 2D collision test.
 */
export function blockAgainstThings(px: number, py: number, things: readonly BlockThing[], radius: number): { x: number; y: number } {
    for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (const o of things) {
            const dx = px - o.x;
            const dy = py - o.y;
            const rr = radius + o.radius;
            const d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr) continue;
            const d = Math.sqrt(d2) || 1e-4;
            const push = rr - d;
            px += (dx / d) * push;
            py += (dy / d) * push;
            moved = true;
        }
        if (!moved) break;
    }
    return { x: px, y: py };
}

function closestPointOnSegment(line: CollLine, px: number, py: number): { x: number; y: number } {
    const ax = line.x1;
    const ay = line.y1;
    const bx = line.x2;
    const by = line.y2;
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-9) return { x: ax, y: ay };
    let t = ((px - ax) * abx + (py - ay) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    return { x: ax + t * abx, y: ay + t * aby };
}
