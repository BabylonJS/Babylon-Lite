// Builds renderable geometry (walls + floors/ceilings) from a parsed DOOM map,
// batched by texture. Coordinate mapping: world = (doomX, height, doomY).
//
// Wall texturing uses Doom's `textureMid - worldY` pegging model; floors/ceilings
// use world-aligned 64-unit flat tiling. Per-vertex color carries sector light
// (r) and a fullbright flag (g) for the colormap material.

import type { DoomMap, Sector, Sidedef } from "../wad/map.js";
import type { DoomTextureCache } from "../render/texture-cache.js";
import { SKY_FLAT } from "../render/texture-cache.js";
import { buildSubsectorPolygons } from "./bsp.js";

const ML_DONTPEGTOP = 0x0008;
const ML_DONTPEGBOTTOM = 0x0010;

export interface Batch {
    pos: number[];
    uv: number[];
    col: number[];
    idx: number[];
}

export type LevelBatches = Map<string, Batch>;

export interface GeometryFilter {
    /** Return true to emit wall geometry for this linedef index. */
    includeLine?: (ldIndex: number) => boolean;
    /** Return true to emit floor/ceiling geometry for this subsector index. */
    includeSubsector?: (ssIndex: number) => boolean;
}

function batchFor(map: LevelBatches, name: string): Batch {
    let b = map.get(name);
    if (!b) {
        b = { pos: [], uv: [], col: [], idx: [] };
        map.set(name, b);
    }
    return b;
}

function light01(level: number): number {
    return Math.max(0, Math.min(255, level)) / 255;
}

interface V3 {
    x: number;
    y: number;
    z: number;
}

function addQuad(b: Batch, c: [V3, V3, V3, V3], uv: [number, number][], lr: number): void {
    const base = b.pos.length / 3;
    for (let i = 0; i < 4; i++) {
        b.pos.push(c[i].x, c[i].y, c[i].z);
        b.uv.push(uv[i][0], uv[i][1]);
        b.col.push(lr, 0, 0, 1);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

export function buildLevelBatches(map: DoomMap, textures: DoomTextureCache, filter: GeometryFilter = {}): LevelBatches {
    const batches: LevelBatches = new Map();
    buildWalls(map, textures, batches, filter.includeLine);
    buildFlats(map, textures, batches, filter.includeSubsector);
    return batches;
}

function buildWalls(map: DoomMap, textures: DoomTextureCache, batches: LevelBatches, includeLine?: (i: number) => boolean): void {
    for (let li = 0; li < map.linedefs.length; li++) {
        if (includeLine && !includeLine(li)) continue;
        const ld = map.linedefs[li];
        if (ld.front < 0) continue;
        const v1 = map.vertices[ld.start];
        const v2 = map.vertices[ld.end];
        if (!v1 || !v2) continue;
        const len = Math.hypot(v2.x - v1.x, v2.y - v1.y);

        const frontSide = map.sidedefs[ld.front];
        const frontSec = map.sectors[frontSide.sector];
        const backSide = ld.back >= 0 ? map.sidedefs[ld.back] : null;
        const backSec = backSide ? map.sectors[backSide.sector] : null;

        // Doom "fake contrast": E-W walls darker, N-S walls brighter.
        let contrast = 0;
        if (v1.y === v2.y) contrast = -16;
        else if (v1.x === v2.x) contrast = +16;

        if (!backSec) {
            // One-sided solid wall: full floor→ceiling, middle texture.
            emitWallSegment(
                batches,
                textures,
                frontSide.middle,
                v1,
                v2,
                len,
                frontSec.floorHeight,
                frontSec.ceilHeight,
                frontSide,
                (texH) => (ld.flags & ML_DONTPEGBOTTOM ? frontSec.floorHeight + texH : frontSec.ceilHeight) + frontSide.yOffset,
                light01(frontSec.light + contrast)
            );
            continue;
        }

        const skyBoth = frontSec.ceilTex === SKY_FLAT && backSec.ceilTex === SKY_FLAT;

        // Front side lower / upper.
        if (backSec.floorHeight > frontSec.floorHeight) {
            emitWallSegment(
                batches,
                textures,
                frontSide.lower,
                v1,
                v2,
                len,
                frontSec.floorHeight,
                backSec.floorHeight,
                frontSide,
                (texH) => (ld.flags & ML_DONTPEGBOTTOM ? frontSec.ceilHeight : backSec.floorHeight + texH) + frontSide.yOffset,
                light01(frontSec.light + contrast)
            );
        }
        if (!skyBoth && backSec.ceilHeight < frontSec.ceilHeight) {
            emitWallSegment(
                batches,
                textures,
                frontSide.upper,
                v1,
                v2,
                len,
                backSec.ceilHeight,
                frontSec.ceilHeight,
                frontSide,
                (texH) => (ld.flags & ML_DONTPEGTOP ? frontSec.ceilHeight : backSec.ceilHeight + texH) + frontSide.yOffset,
                light01(frontSec.light + contrast)
            );
        }

        // Back side lower / upper (opposite comparisons / viewpoint).
        if (backSide) {
            if (frontSec.floorHeight > backSec.floorHeight) {
                emitWallSegment(
                    batches,
                    textures,
                    backSide.lower,
                    v1,
                    v2,
                    len,
                    backSec.floorHeight,
                    frontSec.floorHeight,
                    backSide,
                    (texH) => (ld.flags & ML_DONTPEGBOTTOM ? backSec.ceilHeight : frontSec.floorHeight + texH) + backSide.yOffset,
                    light01(backSec.light + contrast)
                );
            }
            if (!skyBoth && frontSec.ceilHeight < backSec.ceilHeight) {
                emitWallSegment(
                    batches,
                    textures,
                    backSide.upper,
                    v1,
                    v2,
                    len,
                    frontSec.ceilHeight,
                    backSec.ceilHeight,
                    backSide,
                    (texH) => (ld.flags & ML_DONTPEGTOP ? backSec.ceilHeight : frontSec.ceilHeight + texH) + backSide.yOffset,
                    light01(backSec.light + contrast)
                );
            }
        }
    }
}

function emitWallSegment(
    batches: LevelBatches,
    textures: DoomTextureCache,
    texName: string,
    v1: { x: number; y: number },
    v2: { x: number; y: number },
    len: number,
    yBottom: number,
    yTop: number,
    side: Sidedef,
    textureMidFn: (texH: number) => number,
    lr: number
): void {
    if (yTop <= yBottom) return;
    const tex = textures.getWall(texName);
    if (!tex) return;
    const { width: texW, height: texH } = tex;
    const textureMid = textureMidFn(texH);

    const u1 = side.xOffset / texW;
    const u2 = (side.xOffset + len) / texW;
    const vTop = (textureMid - yTop) / texH;
    const vBottom = (textureMid - yBottom) / texH;

    const batch = batchFor(batches, texName);
    addQuad(
        batch,
        [
            { x: v1.x, y: yBottom, z: v1.y },
            { x: v2.x, y: yBottom, z: v2.y },
            { x: v2.x, y: yTop, z: v2.y },
            { x: v1.x, y: yTop, z: v1.y },
        ],
        [
            [u1, vBottom],
            [u2, vBottom],
            [u2, vTop],
            [u1, vTop],
        ],
        lr
    );
}

function buildFlats(map: DoomMap, textures: DoomTextureCache, batches: LevelBatches, includeSubsector?: (i: number) => boolean): void {
    const polys = buildSubsectorPolygons(map);
    for (let i = 0; i < map.subsectors.length; i++) {
        if (includeSubsector && !includeSubsector(i)) continue;
        const poly = polys[i];
        const ss = map.subsectors[i];
        if (!poly || poly.length < 3 || ss.segCount === 0) continue;
        const sector = sectorOfSubsector(map, i);
        if (!sector) continue;

        const floorTex = textures.getFlat(sector.floorTex);
        if (floorTex) addFlatPoly(batchFor(batches, sector.floorTex), poly, sector.floorHeight, light01(sector.light), false);

        if (sector.ceilTex !== SKY_FLAT) {
            const ceilTex = textures.getFlat(sector.ceilTex);
            if (ceilTex) addFlatPoly(batchFor(batches, sector.ceilTex), poly, sector.ceilHeight, light01(sector.light), true);
        }
    }
}

function sectorOfSubsector(map: DoomMap, ssIndex: number): Sector | null {
    const idx = sectorIndexOfSubsector(map, ssIndex);
    return idx < 0 ? null : (map.sectors[idx] ?? null);
}

/** Index of the sector a subsector belongs to, or -1 if undeterminable. */
export function sectorIndexOfSubsector(map: DoomMap, ssIndex: number): number {
    const ss = map.subsectors[ssIndex];
    const seg = map.segs[ss.firstSeg];
    if (!seg) return -1;
    const ld = map.linedefs[seg.linedef];
    if (!ld) return -1;
    const sideRef = seg.side === 0 ? ld.front : ld.back;
    if (sideRef < 0) return -1;
    const side = map.sidedefs[sideRef];
    return side ? side.sector : -1;
}

function addFlatPoly(b: Batch, poly: { x: number; y: number }[], height: number, lr: number, ceiling: boolean): void {
    const base = b.pos.length / 3;
    for (const p of poly) {
        b.pos.push(p.x, height, p.y);
        b.uv.push(p.x / 64, p.y / 64);
        b.col.push(lr, 0, 0, 1);
    }
    // Fan triangulation; reverse for ceilings so future back-face culling is correct.
    for (let i = 1; i < poly.length - 1; i++) {
        if (ceiling) b.idx.push(base, base + i + 1, base + i);
        else b.idx.push(base, base + i, base + i + 1);
    }
}
