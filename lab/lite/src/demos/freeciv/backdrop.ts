/**
 * Backdrop for the Freeciv demo — a subdued public-domain Mercator 1569 world
 * map behind the playfield, plus a soft sea-blue halo around the iso map so its
 * coastline edges melt into open water instead of cutting off abruptly.
 *
 * Both pieces live in *world* space (the same pixel coordinates the tiles use),
 * so they pan and zoom with the map: the demo's `applyView` drives their layer
 * view exactly as it does the terrain layers. They never animate, so there is no
 * per-frame work — just three static sprites placed once at build.
 *
 * Layer order (back → front): parchment (-40) → wash (-39) → … clouds … → sea
 * halo (-5) → ocean tiles (0). The parchment is darkened via a multiply tint, then
 * a flat translucent wash is laid over it: the Mercator's *recognisable* real-world
 * coastlines read as "a photo of a real map slid behind the game", which fights the
 * fantasy island. The wash collapses its contrast so it abstracts into aged-paper
 * texture rather than legible geography. The sea halo is a feathered radial that
 * fades from watery blue at the map to transparent at its rim.
 */

import {
    addSprite2DIndex,
    createGridSpriteAtlas,
    createSprite2DLayer,
    createTexture2DFromPixels,
    loadTexture2D,
    type EngineContext,
    type Sprite2DLayer,
} from "babylon-lite";
import { TILE_H, TILE_W, isoCentre } from "./iso.js";
import type { GameMap } from "./worldgen.js";

export interface Backdrop {
    /** Layers to splice into the demo's panned/zoomed `layers` array (behind the map). */
    layers: Sprite2DLayer[];
}

/** Multiply tint that darkens + warms the parchment so tiles read clearly over it. */
const PARCHMENT_TINT: [number, number, number, number] = [0.5, 0.45, 0.38, 1];
/** Flat warm-paper colour laid over the Mercator to mute its contrast. */
const WASH_RGB: [number, number, number] = [120, 106, 86];
/** How opaque the wash is — higher = more abstract, less legible coastline. */
const WASH_ALPHA = 0.55;
/** How far the parchment extends past the map bounds (covers the void when zoomed out). */
const PARCHMENT_COVER = 2.6;
/** How far the sea halo bleeds past the map edge. */
const SEA_COVER = 1.35;
/** Watery blue of the halo core. */
const SEA_RGB: [number, number, number] = [34, 78, 116];

/** Pixel bounding box of the whole iso map (tile centres expanded by a tile). */
function mapBounds(world: GameMap): { cx: number; cy: number; w: number; h: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
            const [px, py] = isoCentre(x, y);
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
    }
    minX -= TILE_W / 2;
    maxX += TILE_W / 2;
    minY -= TILE_H / 2;
    maxY += TILE_H / 2;
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** A `size×size` RGBA radial: opaque sea-blue at the centre, feathering to clear. */
function makeSeaHalo(size: number): Uint8Array {
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x / (size - 1) - 0.5;
            const dy = y / (size - 1) - 0.5;
            const r = Math.hypot(dx, dy) / 0.5; // 0 centre → 1 at edge midpoints
            // Hold solid out to ~0.55, then ease to 0 by the rim.
            const t = Math.max(0, Math.min(1, (r - 0.55) / 0.45));
            const a = (1 - t * t * (3 - 2 * t)) * 0.5; // peak alpha 0.5
            const o = (y * size + x) * 4;
            px[o] = SEA_RGB[0];
            px[o + 1] = SEA_RGB[1];
            px[o + 2] = SEA_RGB[2];
            px[o + 3] = Math.round(a * 255);
        }
    }
    return px;
}

/** Build the {@link Backdrop}. `mercatorUrl` points at the fetched PD PNG. */
export async function createBackdrop(engine: EngineContext, world: GameMap, mercatorUrl: string): Promise<Backdrop> {
    const b = mapBounds(world);

    // ── Parchment world map (farthest back) ─────────────────────────────────
    const tex = await loadTexture2D(engine, mercatorUrl, {
        invertY: false,
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        mipMaps: true,
        // Photographic backdrop — smooth sampling, unlike the nearest-filtered tiles.
        minFilter: "linear",
        magFilter: "linear",
    });
    const parchAtlas = createGridSpriteAtlas(tex, { cellWidthPx: tex.width, cellHeightPx: tex.height, pivot: [0.5, 0.5] });
    const parchLayer = createSprite2DLayer(parchAtlas, { capacity: 1, order: -40, pivot: [0.5, 0.5] });
    addSprite2DIndex(parchLayer, {
        positionPx: [b.cx, b.cy],
        sizePx: [b.w * PARCHMENT_COVER, b.h * PARCHMENT_COVER],
        color: PARCHMENT_TINT,
    });

    // ── Contrast wash (flat paper over the Mercator) ────────────────────────
    // A solid warm-paper rectangle at partial alpha blended over the map collapses
    // its light/dark range, so the recognisable real coastlines stop reading as a
    // specific place and the backdrop abstracts into aged-paper texture.
    const washPx = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
        washPx[i * 4] = WASH_RGB[0];
        washPx[i * 4 + 1] = WASH_RGB[1];
        washPx[i * 4 + 2] = WASH_RGB[2];
        washPx[i * 4 + 3] = 255;
    }
    const washTex = createTexture2DFromPixels(engine, washPx, 4, 4);
    const washAtlas = createGridSpriteAtlas(washTex, { cellWidthPx: 4, cellHeightPx: 4, pivot: [0.5, 0.5] });
    const washLayer = createSprite2DLayer(washAtlas, { capacity: 1, order: -39, pivot: [0.5, 0.5] });
    addSprite2DIndex(washLayer, {
        positionPx: [b.cx, b.cy],
        sizePx: [b.w * PARCHMENT_COVER, b.h * PARCHMENT_COVER],
        color: [1, 1, 1, WASH_ALPHA],
    });

    // ── Sea halo (just under the ocean tiles) ───────────────────────────────
    const haloTex = createTexture2DFromPixels(engine, makeSeaHalo(128), 128, 128);
    const haloAtlas = createGridSpriteAtlas(haloTex, { cellWidthPx: 128, cellHeightPx: 128, pivot: [0.5, 0.5] });
    const haloLayer = createSprite2DLayer(haloAtlas, { capacity: 1, order: -5, pivot: [0.5, 0.5] });
    addSprite2DIndex(haloLayer, {
        positionPx: [b.cx, b.cy],
        sizePx: [b.w * SEA_COVER, b.h * SEA_COVER],
    });

    return { layers: [parchLayer, washLayer, haloLayer] };
}
