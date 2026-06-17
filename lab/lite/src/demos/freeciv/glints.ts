/**
 * Water sun-glints for the Freeciv demo — a scatter of bright specular sparkles
 * twinkling on the open sea, as if sunlight were catching the crests of the swell.
 * Same "continuous field" trick as the fog (`fog.ts`): one fullscreen, world-anchored
 * quad whose fragment shader reads the static land/ocean mask and paints animated
 * glints over deep water only. No per-tile sprites, no engine changes, no assets.
 *
 * The sparkle itself is a sparse grid of twinkling points in world space: each grid
 * cell hashes to a jittered position, a blink phase, and an on/off, so only some cells
 * sparkle at any moment and they never pulse in lockstep. Each glint is drawn as a thin
 * streak oriented along a FIXED sun azimuth (the same axis the cloud shadows imply), so
 * it reads as light glancing off a near-flat wavelet rather than a round dot. The whole
 * field is gated by `daylight` (1 by day → 0 at night), so the sea sparkles at noon and
 * goes dark once the sun is down — pairing with the day/night cycle (`daynight.ts`).
 *
 * The mask never changes (the map is fixed) so it is uploaded once; thereafter the demo's
 * tick only re-anchors the quad and feeds the current `daylight` in via the shader params.
 */

import {
    addSprite2DIndex,
    addSpriteRendererLayer,
    createGridSpriteAtlas,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createTexture2DFromPixels,
    removeSpriteRendererLayer,
    setSprite2DShaderParams,
    updateSprite2DIndex,
    type EngineContext,
    type SpriteRenderer,
} from "babylon-lite";
import { TILE_H, TILE_W } from "./iso.js";
import type { GameMap } from "./worldgen.js";

/** Render order: above the ocean shimmer (0.5), below the coast cells (1) and land, so the
 * sparkle sits on the open sea surface and is naturally covered by anything on land. */
const GLINT_ORDER = 0.6;
/** World-pixel block the glint field snaps to, so each sparkle reads as chunky pixel-art. */
const GLINT_PX = 2;
/** World-pixel size of one sparkle cell (smaller = denser scatter of glints). */
const GLINT_CELL = 18;
/** Fraction of cells that are NEVER lit (raises sparsity); `step(GLINT_GATE, hash)` keeps the rest. */
const GLINT_GATE = 0.82;
/** Fixed sun azimuth the glint streaks align to — the same down-sun axis the cloud shadows use. */
const GLINT_ANGLE = Math.atan2(0.32, 0.42);
const GLINT_DIRX = Math.cos(GLINT_ANGLE).toFixed(4);
const GLINT_DIRY = Math.sin(GLINT_ANGLE).toFixed(4);

/** Just the slice of the demo's view the glint field needs. */
export interface GlintsView {
    x: number;
    y: number;
    zoom: number;
    /** Render-target size in device pixels (the sparkle quad fills it). Defaults to the canvas. */
    w?: number;
    h?: number;
}

export interface Glints {
    /** Re-anchor the fullscreen glint quad and feed in the current `daylight` (1 day → 0 night). */
    update: (view: GlintsView, daylight: number) => void;
    /** Remove the glint layer from the renderer. */
    dispose: () => void;
}

/**
 * Glint fragment (one fullscreen quad). In scope: `in.uv` (0..1 across the quad),
 * `in.tint` (`.xy` = world-pixel origin on screen, `.zw` = world-pixel span on screen),
 * `fx.time` (auto-accumulated seconds → twinkle), `fx.params.x` (daylight, 1 day → 0 night),
 * `landTex`/`landSamp` (the per-tile land mask, bilinear), and `L.opacityMul` (multiply the
 * whole result).
 *
 * Per pixel: map the screen position back to a world pixel, snap it to a chunky GLINT_PX block,
 * invert the isometric transform to a tile coordinate and sample the land mask — glints fade out
 * approaching the coast so they only sparkle on open water (the foam owns the shoreline). Then a
 * sparse world-space sparkle grid hashes each cell to a jittered centre, a blink phase and an
 * on/off; each live sparkle is a thin streak along the fixed sun axis, twinkling via `fx.time`,
 * scaled by `daylight` so the sea goes dark at night. The alpha is quantised into hard steps so
 * the glint stays crisp and pixelated.
 */
const GLINT_FRAGMENT = `
let wpx0 = in.tint.xy + in.uv * in.tint.zw;
let wpx = (floor(wpx0 / GLINT_PX) + 0.5) * GLINT_PX;
let tx = wpx.x / ${TILE_W}.0 + wpx.y / ${TILE_H}.0;
let ty = wpx.y / ${TILE_H}.0 - wpx.x / ${TILE_W}.0;
// Off the playfield the land mask reads 0 (ocean) everywhere, which would sparkle the whole
// void around the map. Clip to the actual tile grid so glints only land on real map tiles.
if (tx < 0.0 || tx >= GLINT_W || ty < 0.0 || ty >= GLINT_H) { discard; }
let lm = textureSampleLevel(landTex, landSamp, vec2<f32>((tx + 0.5) / GLINT_W, (ty + 0.5) / GLINT_H), 0.0).r;
// Open-sea mask: full strength on deep water, fading out within ~a tile of the coast.
let sea = 1.0 - smoothstep(0.02, 0.18, lm);
if (sea <= 0.01) { discard; }
// Sun specular dies at night.
let daylight = fx.params.x;
if (daylight <= 0.01) { discard; }
// Sparse twinkling sparkle grid in world space.
let gp = wpx / GLINT_CELL;
let gi = floor(gp);
let h1 = fract(sin(dot(gi, vec2<f32>(127.1, 311.7))) * 43758.5453);
let h2 = fract(sin(dot(gi, vec2<f32>(269.5, 183.3))) * 43758.5453);
// Only some cells ever light (sparsity), and each blinks on its own phase.
let lit = step(GLINT_GATE, h2);
var tw = sin(fx.time * 2.3 + h1 * 6.2831853);
tw = max(0.0, tw);
tw = tw * tw * tw;
// Jittered sparkle centre inside the cell so glints never sit on a visible lattice.
let centre = (vec2<f32>(h1, h2) - 0.5) * 0.5;
let local = (fract(gp) - 0.5) - centre;
// Thin streak along the fixed sun axis: narrow across the sun direction, longer along it.
let dir = vec2<f32>(GLINT_DIRX, GLINT_DIRY);
let perp = vec2<f32>(-dir.y, dir.x);
let along = dot(local, dir);
let across = dot(local, perp);
let streak = exp(-across * across * 130.0) * exp(-along * along * 26.0);
let spark = streak * tw * lit * sea * daylight;
// Hard pixel-art steps so the glint reads as crisp light, not a soft blob.
var a2 = 0.0;
if (spark > 0.45) { a2 = 0.95; } else if (spark > 0.2) { a2 = 0.55; } else if (spark > 0.07) { a2 = 0.22; }
if (a2 <= 0.01) { discard; }
return vec4<f32>(1.0, 0.97, 0.86, a2) * L.opacityMul;
`;

/**
 * Build the {@link Glints}: a fullscreen sparkle quad driven by {@link GLINT_FRAGMENT}
 * plus the static land mask it samples. Adds the layer to `sr` at {@link GLINT_ORDER}.
 */
export function createGlints(engine: EngineContext, sr: SpriteRenderer, world: GameMap): Glints {
    const { width, height } = world;

    // Static land mask: R = 255 on land, 0 on ocean; bilinear so the 0.5 contour traces the
    // coastline and the open-sea mask fades smoothly. Uploaded once — the map never changes.
    const mask = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (world.isLand(x, y)) mask[(y * width + x) * 4] = 255;
        }
    }
    const landTex = createTexture2DFromPixels(engine, mask, width, height, { minFilter: "linear", magFilter: "linear" });

    // One fullscreen quad on a 1×1 white atlas (the shader synthesises every pixel and never
    // samples the atlas); the land mask is bound as the extra `land` texture. GLINT_W / GLINT_H
    // let the shader map a world pixel back to a tile coordinate.
    const whiteTex = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
    const atlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: 1, cellHeightPx: 1, pivot: [0.5, 0.5] });
    const fragment = `const GLINT_W = ${width}.0;\nconst GLINT_H = ${height}.0;\nconst GLINT_PX = ${GLINT_PX}.0;\nconst GLINT_CELL = ${GLINT_CELL}.0;\nconst GLINT_GATE = ${GLINT_GATE};\nconst GLINT_DIRX = ${GLINT_DIRX};\nconst GLINT_DIRY = ${GLINT_DIRY};\n${GLINT_FRAGMENT}`;
    const shader = createSprite2DCustomShader({ fragment, extraTextures: [{ name: "land", texture: landTex }] });
    const layer = createSprite2DLayer(atlas, { capacity: 1, order: GLINT_ORDER, pivot: [0.5, 0.5], customShader: shader });
    addSpriteRendererLayer(sr, layer);
    const sprite = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [1, 1], frame: 0, color: [0, 0, 0, 0], visible: false });

    return {
        update(view: GlintsView, daylight: number): void {
            // Below ~1% daylight there is nothing to draw — hide the quad entirely.
            if (daylight <= 0.01) {
                updateSprite2DIndex(layer, sprite, { visible: false });
                return;
            }
            // Fullscreen quad centred on the canvas; the tint carries the world rectangle
            // currently on screen (a world point W draws at (W − view) · zoom, so screen uv 0
            // is world `view` and the span is `canvas / zoom`). `daylight` rides in fx.params.x.
            const w = view.w ?? (engine.canvas.width || 1);
            const h = view.h ?? (engine.canvas.height || 1);
            updateSprite2DIndex(layer, sprite, {
                positionPx: [w * 0.5, h * 0.5],
                sizePx: [w, h],
                color: [view.x, view.y, w / view.zoom, h / view.zoom],
                visible: true,
            });
            setSprite2DShaderParams(layer, [daylight, 0, 0, 0]);
        },
        dispose(): void {
            removeSpriteRendererLayer(sr, layer);
        },
    };
}
