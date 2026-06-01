/**
 * "Living water" overlay for the Freeciv demo — a gentle animated caustic
 * shimmer drawn on top of every ocean tile so the sea ripples instead of sitting
 * as a flat dark slab. Pure sprite path, no engine changes, no committed assets.
 *
 * The shimmer is a procedural caustic *flipbook*: at load we synthesise N frames
 * of a diamond-masked caustic pattern (interfering sine waves whose phase loops
 * cleanly over the N frames) in several distinct spatial *variants*, baked into a
 * single atlas grid, then drop one sprite on each ocean tile. Each tile is given
 * its own spatial variant (by hash, so neighbours never share the same diamond
 * shimmer → no tiled look) plus its own phase offset — part travelling wave (so
 * ripples sweep across the map), part hash (so neighbours never pulse in
 * lock-step) — and we only nudge a tile's frame when the global flipbook index
 * actually advances (~12 fps), keeping the per-frame cost to a cheap throttle.
 *
 * Blending is plain alpha (additive isn't on the sprite path yet), so the caustic
 * veins read as pale light playing over the deep water rather than glare.
 */

import {
    addSprite2DIndex,
    createGridSpriteAtlas,
    createSprite2DLayer,
    createTexture2DFromPixels,
    updateSprite2DIndex,
    type EngineContext,
    type Sprite2DLayer,
} from "babylon-lite";
import { TILE_H, TILE_W, isoCentre } from "./iso.js";
import type { GameMap } from "./worldgen.js";

export interface Water {
    /** The shimmer layer — caller adds it to the panned/zoomed map layers. */
    layer: Sprite2DLayer;
    /** Advance the caustic flipbook (call once per frame). */
    update: () => void;
}

/** Caustic flipbook frame count; phase loops cleanly across these. */
const FRAMES = 24;
/** Distinct spatial caustic patterns; each ocean tile is assigned one by hash so
 * neighbours never share the same diamond shimmer (kills the tiled look). */
const VARIANTS = 6;
/** Milliseconds each flipbook frame is held (~6 fps — a slow, calm shimmer). */
const FRAME_MS = 160;
/** Peak overlay opacity in a caustic crest. */
const MAX_ALPHA = 0.32;
/** Size of a "pixel" block (device px). The caustic is sampled once per block and
 * filled flat, so the shimmer reads as chunky pixel-art sparkle, not smooth blobs. */
const BLOCK = 3;

/** Cheap deterministic hash of a tile coord → [0,1). */
function hash2(x: number, y: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}

/**
 * Render the caustic flipbook into one RGBA atlas grid: `FRAMES` columns (the
 * animation) × `VARIANTS` rows (distinct spatial patterns). Each cell is masked to
 * the iso diamond and fades at its edge so it never bleeds onto neighbouring land.
 * Frame index for (variant, frame) is `variant * FRAMES + frame` (row-major).
 *
 * The field is sampled once per `BLOCK×BLOCK` block and the brightness quantised to
 * a few hard levels, so the shimmer looks like lit pixels twinkling on the water
 * rather than smooth rounded shapes — matching the chunky tileset's pixel-art feel.
 */
function makeCausticAtlas(): { data: Uint8Array; width: number; height: number } {
    const w = TILE_W * FRAMES;
    const h = TILE_H * VARIANTS;
    const data = new Uint8Array(w * h * 4);
    for (let vr = 0; vr < VARIANTS; vr++) {
        // Per-variant spatial offset + phase seed → a different caustic shape.
        const s = vr * 1.6180339887;
        const ax = 0.7 * Math.cos(s);
        const ay = 0.7 * Math.sin(s * 1.3);
        for (let f = 0; f < FRAMES; f++) {
            const phase = (f / FRAMES) * Math.PI * 2;
            // March in BLOCK steps so each block is one flat "pixel".
            for (let by = 0; by < TILE_H; by += BLOCK) {
                for (let bx = 0; bx < TILE_W; bx += BLOCK) {
                    // Sample the field at the block centre.
                    const cx = Math.min(bx + (BLOCK >> 1), TILE_W - 1);
                    const cy = Math.min(by + (BLOCK >> 1), TILE_H - 1);
                    const u = ((cx + 0.5) / TILE_W) * 2 - 1; // [-1,1]
                    const v = ((cy + 0.5) / TILE_H) * 2 - 1; // [-1,1]
                    // Hard diamond mask (no feather → stair-stepped pixel edge).
                    const inDiamond = Math.abs(u) + Math.abs(v) <= 0.96;
                    let alpha = 0;
                    if (inDiamond) {
                        const uu = u + ax;
                        const vv = v + ay;
                        // Three drifting wave fronts; +phase keeps the loop seamless,
                        // +s shifts the pattern so each variant looks different.
                        let c = 0;
                        c += Math.sin((uu * 3.1 + vv * 1.7) * Math.PI + phase + s);
                        c += Math.sin((uu * -2.3 + vv * 2.9) * Math.PI + phase * 1.3 + 1.7 + s * 2);
                        c += Math.sin((uu * 1.3 - vv * 3.7) * Math.PI - phase * 0.8 + 4.1 + s * 0.5);
                        c /= 3; // [-1,1]
                        // Quantise the crest into a couple of hard pixel levels: only the
                        // brightest crests sparkle, with a faint band just below — keeps the
                        // water calm and uncluttered rather than a busy field of specks.
                        if (c > 0.78) alpha = MAX_ALPHA;
                        else if (c > 0.6) alpha = MAX_ALPHA * 0.4;
                    }
                    const a8 = Math.round(alpha * 255);
                    // Fill the whole block with the flat sampled value.
                    for (let j = by; j < by + BLOCK && j < TILE_H; j++) {
                        for (let i = bx; i < bx + BLOCK && i < TILE_W; i++) {
                            const o = ((vr * TILE_H + j) * w + (f * TILE_W + i)) * 4;
                            data[o] = 200;
                            data[o + 1] = 226;
                            data[o + 2] = 246;
                            data[o + 3] = a8;
                        }
                    }
                }
            }
        }
    }
    return { data, width: w, height: h };
}

/** Build the {@link Water} shimmer for every ocean tile in `world`. */
export function createWater(engine: EngineContext, world: GameMap): Water {
    const { data, width, height } = makeCausticAtlas();
    const tex = createTexture2DFromPixels(engine, data, width, height);
    const atlas = createGridSpriteAtlas(tex, { cellWidthPx: TILE_W, cellHeightPx: TILE_H });

    // One sprite per ocean tile, sitting just above the ocean base (order 0) and
    // below the coastline foam (order 1).
    const tiles: { x: number; y: number }[] = [];
    for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
            if (world.isOcean(x, y)) tiles.push({ x, y });
        }
    }

    const layer = createSprite2DLayer(atlas, { capacity: tiles.length || 1, order: 0.5 });
    const sprites: number[] = [];
    const phase: number[] = [];
    const variant: number[] = [];
    for (const { x, y } of tiles) {
        const [px, py] = isoCentre(x, y);
        // Travelling wave across the map + per-tile jitter so it never marches in step.
        const p = Math.round(x * 0.7 + y * 0.4 + hash2(x, y) * FRAMES) % FRAMES;
        // Distinct spatial pattern per tile so the sea never looks like one repeated
        // diamond. Mix two hashes so neighbours rarely pick the same variant.
        const vr = Math.floor(hash2(x * 3 + 1, y * 5 + 2) * VARIANTS) % VARIANTS;
        phase.push(p);
        variant.push(vr);
        sprites.push(addSprite2DIndex(layer, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame: vr * FRAMES + p }));
    }

    let lastIndex = -1;
    return {
        layer,
        update(): void {
            const index = Math.floor(performance.now() / FRAME_MS);
            if (index === lastIndex) return; // throttle to the flipbook rate
            lastIndex = index;
            for (let i = 0; i < sprites.length; i++) {
                updateSprite2DIndex(layer, sprites[i]!, { frame: variant[i]! * FRAMES + ((index + phase[i]!) % FRAMES) });
            }
        },
    };
}
