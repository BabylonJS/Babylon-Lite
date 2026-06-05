/**
 * "Living water" overlay for the Freeciv demo — a gentle animated caustic
 * shimmer drawn on top of every ocean tile so the sea ripples instead of sitting
 * as a flat dark slab. Pure sprite path, no engine changes, no committed assets.
 *
 * This is the GPU version: instead of baking a caustic *flipbook* atlas on the CPU
 * and nudging each tile's frame every ~6 fps, we drop one white quad on each ocean
 * tile and let a custom WGSL fragment shader synthesise the caustic live. The
 * shimmer therefore runs at the full frame rate with zero per-frame CPU work — the
 * engine auto-accumulates `fx.time`, so the field animates for free.
 *
 * Continuity trick: each tile's per-sprite `tint` encodes its *normalised map
 * position* (`x/width`, `y/height`) plus a hash in `.z`. The shader reconstructs a
 * shared, map-wide caustic coordinate from that, so the wave fronts drift smoothly
 * across the whole sea rather than repeating identically per diamond. The diamond
 * mask is computed from `in.uv` and pixel-snapped like the rest of the effect: a hard
 * `select` confines the shimmer to the inner ~82% of the diamond and `discard`s past
 * its edge, leaving a margin of bare water so the caustic never reaches the tile
 * boundary (no bleed onto neighbouring land, and the overlay adds nothing along the
 * tile seams). The cutoff is intentionally hard — not a soft fade — to match the
 * chunky pixel-art look (pixel-snapped cells + hard alpha steps); any residual seam
 * *between the ocean base tiles themselves* is handled by the demo's integer-zoom
 * snapping, not by this overlay.
 *
 * Blending is plain alpha, so the caustic veins read as pale light playing over the
 * deep water rather than glare.
 */

import {
    addSprite2DIndex,
    createGridSpriteAtlas,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createTexture2DFromPixels,
    type EngineContext,
    type Sprite2DLayer,
} from "babylon-lite";
import { TILE_H, TILE_W, isoCentre } from "./iso.js";
import type { GameMap } from "./worldgen.js";

export interface Water {
    /** The shimmer layer — caller adds it to the panned/zoomed map layers. */
    layer: Sprite2DLayer;
    /** No-op: the caustic animates on the GPU via auto-accumulated `fx.time`. Kept
     * so the demo's tick loop can call it unconditionally. */
    update: () => void;
}

/** Cheap deterministic hash of a tile coord → [0,1). */
function hash2(x: number, y: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}

/**
 * WGSL caustic fragment. In scope: `in.uv` (0..1 across the quad), `in.tint`
 * (per-sprite colour — here `[x/width, y/height, hash, 1]`), `fx.time` (seconds,
 * auto-accumulated), and `L.opacityMul`. Minimal whitespace: the prod build
 * minifies inline WGSL.
 */
const CAUSTIC_FRAGMENT = `let cell = vec2<f32>(${TILE_W}.0, ${TILE_H}.0) / 3.0;
let uvq = (floor(in.uv * cell) + 0.5) / cell;
let p = uvq * 2.0 - 1.0;
let d = abs(p.x) + abs(p.y);
if (d > 0.96) { discard; }
let t = floor(fx.time * 6.0) / 6.0;
let ph = in.tint.z * 6.2831853;
let q = in.tint.xy * 40.0 + p * 0.9;
var c = sin((q.x * 3.1 + q.y * 1.7) * 3.1415927 + t * 0.9 + ph);
c = c + sin((q.x * -2.3 + q.y * 2.9) * 3.1415927 + t * 1.2 + 1.7 + ph);
c = c + sin((q.x * 1.3 - q.y * 3.7) * 3.1415927 - t * 0.7 + 4.1);
c = c / 3.0;
var crest = 0.0;
if (c > 0.78) { crest = 0.32; } else if (c > 0.6) { crest = 0.13; }
let edge = select(0.0, 1.0, d < 0.82);
let a = crest * edge;
return vec4<f32>(0.78, 0.88, 0.96, a) * L.opacityMul;`;

/** Build the {@link Water} shimmer for every ocean tile in `world`. */
export function createWater(engine: EngineContext, world: GameMap): Water {
    // 1×1 white atlas — the quad's colour comes entirely from the shader; the
    // texture exists only because a layer requires an atlas.
    const tex = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
    const atlas = createGridSpriteAtlas(tex, { cellWidthPx: 1, cellHeightPx: 1 });

    const customShader = createSprite2DCustomShader({ fragment: CAUSTIC_FRAGMENT });

    // One sprite per ocean tile, sitting just above the ocean base (order 0) and
    // below the coastline foam (order 1).
    const tiles: { x: number; y: number }[] = [];
    for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
            if (world.isOcean(x, y)) tiles.push({ x, y });
        }
    }

    const layer = createSprite2DLayer(atlas, { capacity: tiles.length || 1, order: 0.5, customShader });
    const invW = 1 / Math.max(1, world.width);
    const invH = 1 / Math.max(1, world.height);
    for (const { x, y } of tiles) {
        const [px, py] = isoCentre(x, y);
        // tint = normalised map position (for the shared, map-wide caustic field) +
        // per-tile hash in `.z` (a phase offset so neighbours never pulse in step).
        addSprite2DIndex(layer, {
            positionPx: [px, py],
            sizePx: [TILE_W, TILE_H],
            frame: 0,
            color: [x * invW, y * invH, hash2(x, y), 1],
        });
    }

    return {
        layer,
        update(): void {
            /* GPU-driven: the caustic animates from auto-accumulated `fx.time`. */
        },
    };
}
