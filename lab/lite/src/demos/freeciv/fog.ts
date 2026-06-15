/**
 * Fog of war for the Freeciv demo — a single **continuous haze field**, not a grid
 * of per-tile diamonds. Mirrors the atmosphere clouds: one fullscreen, world-anchored
 * quad whose fragment shader reads the live sight state from a tiny per-tile texture
 * and paints a drifting mist over everything the player can't currently watch.
 *
 * Why a field instead of one sprite per tile: a fog sprite can only carry a few floats
 * (its tint), so every tile decides its own opacity independently and the seams between
 * tiles fall on the diamond grid — you see the hard isometric silhouette no matter how
 * much you soften each tile. Here the per-tile haze lives in a `width × height` texture
 * sampled with **bilinear** filtering, so the sight frontier interpolates *across* tile
 * boundaries into one smooth scalar field; a world-space fBm then frays that field's
 * contour into organic wisps. There is no tile geometry in the output at all, so the
 * sawtooth is structurally impossible.
 *
 * The CPU only maintains the field: it eases each tile's haze toward its sight target
 * (visible → clear, charted → soft haze) and re-uploads the texture on the frames a
 * tile actually changed. All the shaping — the smooth frontier, the living drift, the
 * wispy edge — happens per-pixel on the GPU. No engine changes, no assets.
 */

import {
    addSprite2DIndex,
    addSpriteRendererLayer,
    createGridSpriteAtlas,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createTexture2DFromPixels,
    removeSpriteRendererLayer,
    updateSprite2DIndex,
    type EngineContext,
    type SpriteRenderer,
    type Texture2D,
} from "babylon-lite";
import { TILE_H, TILE_W } from "./iso.js";
import type { GameMap } from "./worldgen.js";

/** Tile sight radius (Manhattan) around cities and the scout. */
const CITY_SIGHT = 2;
const SCOUT_SIGHT = 3;
/** Haze opacity for charted-but-unwatched land vs. never-charted (here the map starts charted). */
const EXPLORED_ALPHA = 0.72;
const UNEXPLORED_ALPHA = 0.92;
/** Milliseconds for a tile's haze to fade in/out when sight changes (the dissolve). */
const FOG_EASE_MS = 450;
/** Render order: above units/cities/wildlife, below the selection ring + clouds. */
const FOG_ORDER = 13;
/** World-pixel → noise scale: one fBm base cell ≈ 1/FOG_NOISE_SCALE world px (a few tiles). */
const FOG_NOISE_SCALE = 0.006;

/** Just the slice of the demo's view the fog field needs. */
export interface FogView {
    x: number;
    y: number;
    zoom: number;
    /** Render-target size in device pixels (the haze quad fills it). Defaults to the canvas. */
    w?: number;
    h?: number;
}

export interface Fog {
    /**
     * Re-anchor the fullscreen haze quad for the current view and refresh sight around
     * the cities + the scout's current tile (`sx`, `sy`). Recomputes the sight stencil
     * only when the scout changes tile; otherwise just eases tiles still in transition.
     */
    update: (view: FogView, sx: number, sy: number) => void;
    /** Remove the fog layer from the renderer. */
    dispose: () => void;
}

/**
 * Fog fragment (one fullscreen quad). In scope: `in.uv` (0..1 across the quad), `in.tint`
 * (`.xy` = world-pixel origin on screen, `.zw` = world-pixel span on screen), `fx.time`
 * (auto-accumulated seconds → wind drift), `fieldTex`/`fieldSamp` (the per-tile haze field,
 * bilinear), and `L.opacityMul` (a vec4 — multiply the whole result, never just alpha).
 *
 * Per pixel: map the screen position back to a world pixel, invert the isometric transform
 * to a *continuous* tile coordinate, and sample the haze field there. Bilinear filtering
 * turns the per-tile haze into a smooth field whose 0→haze frontier crosses tile edges
 * seamlessly. A world-anchored fBm both *breathes* the interior density and perturbs the
 * coverage threshold, so the frontier dissolves into drifting wisps while solid interiors
 * stay solid (the noise can't open holes where the field is already deep).
 */
const FOG_FRAGMENT = `
let wpx = in.tint.xy + in.uv * in.tint.zw;
let tx = wpx.x / ${TILE_W}.0 + wpx.y / ${TILE_H}.0;
let ty = wpx.y / ${TILE_H}.0 - wpx.x / ${TILE_W}.0;
// Off the map the field sampler clamps to its edge texels (≈ charted haze), which would
// smear fog across the void around the island. Discard fragments outside the tile grid so
// fog stays confined to real tiles (mirrors the bounds clip in glints.ts). The ±0.5 margin
// keeps each rim tile's full diamond — tile centre i spans tx ∈ [i-0.5, i+0.5].
if (tx < -0.5 || tx > FOG_W - 0.5 || ty < -0.5 || ty > FOG_H - 0.5) { discard; }
let fuv = vec2<f32>((tx + 0.5) / FOG_W, (ty + 0.5) / FOG_H);
let haze = textureSampleLevel(fieldTex, fieldSamp, fuv, 0.0).r;
if (haze <= 0.004) { discard; }
let wind = vec2<f32>(fx.time * 0.013, fx.time * 0.007);
var p = wpx * ${FOG_NOISE_SCALE} + wind;
var amp = 0.5;
var sum = 0.0;
var norm = 0.0;
for (var o = 0; o < 3; o = o + 1) {
let gi = floor(p);
let gf = fract(p);
let u = gf * gf * (3.0 - 2.0 * gf);
let a = fract(sin(dot(gi, vec2<f32>(127.1, 311.7))) * 43758.5453);
let b = fract(sin(dot(gi + vec2<f32>(1.0, 0.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
let c = fract(sin(dot(gi + vec2<f32>(0.0, 1.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
let d = fract(sin(dot(gi + vec2<f32>(1.0, 1.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
let n = mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
sum = sum + amp * n;
norm = norm + amp;
amp = amp * 0.5;
p = p * 2.0 + vec2<f32>(19.1, 7.7);
}
let f = sum / norm;
let density = 0.82 + 0.26 * f;
// Noisy coverage: push the smoothstep threshold by the noise so the soft frontier
// (where the bilinear field ramps 0→haze) breaks into wisps, while deep fog stays
// fully solid (its haze is well past the band, so noise can't open holes).
let cov = smoothstep(0.05, 0.34, haze + (f - 0.5) * 0.42);
let a2 = clamp(haze * density * cov, 0.0, 1.0);
if (a2 <= 0.004) { discard; }
return vec4<f32>(0.02, 0.025, 0.04, a2) * L.opacityMul;
`;

/**
 * Build the {@link Fog}: a fullscreen haze quad driven by {@link FOG_FRAGMENT} plus the
 * per-tile sight field it samples. Adds the layer to `sr` at {@link FOG_ORDER}.
 */
export function createFog(engine: EngineContext, sr: SpriteRenderer, world: GameMap): Fog {
    const { width, height } = world;
    const cities = world.cities as ReadonlyArray<{ x: number; y: number }>;

    // CPU sight state. The whole map starts charted, so every tile reads as the soft
    // "seen but not currently watched" haze until a city's or the scout's live sight
    // clears it. `explored` is kept for completeness (and a future unexplored-black mode).
    const explored = new Uint8Array(width * height).fill(1);
    const visible = new Uint8Array(width * height);
    const hazeCur = new Float32Array(width * height).fill(EXPLORED_ALPHA);
    const hazeTarget = new Float32Array(width * height).fill(EXPLORED_ALPHA);
    const active = new Set<number>();

    // The field texture the shader samples: R = haze (0..255), bilinear so the frontier
    // interpolates smoothly across tiles. Re-uploaded only on frames a tile changed.
    const field = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) field[i * 4] = Math.round(EXPLORED_ALPHA * 255);
    const fieldTex: Texture2D = createTexture2DFromPixels(engine, field, width, height, {
        minFilter: "linear",
        magFilter: "linear",
    });
    const device = engine._device;
    const uploadField = (): void => {
        device.queue.writeTexture({ texture: fieldTex.texture }, field as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
    };

    // One fullscreen quad on a 1×1 white atlas (the shader synthesises every pixel and
    // never samples the atlas, so the tiny-texture trap doesn't apply); the haze field
    // is bound as the extra `field` texture. FOG_W / FOG_H let the shader map a world
    // pixel back to a tile coordinate to look the field up.
    const whiteTex = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
    const atlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: 1, cellHeightPx: 1, pivot: [0.5, 0.5] });
    const fragment = `const FOG_W = ${width}.0;\nconst FOG_H = ${height}.0;\n${FOG_FRAGMENT}`;
    const shader = createSprite2DCustomShader({ fragment, extraTextures: [{ name: "field", texture: fieldTex }] });
    const layer = createSprite2DLayer(atlas, { capacity: 1, order: FOG_ORDER, pivot: [0.5, 0.5], customShader: shader });
    addSpriteRendererLayer(sr, layer);
    const sprite = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [1, 1], frame: 0, color: [0, 0, 0, 0], visible: false });

    const stampSight = (cx: number, cy: number, r: number): void => {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) + Math.abs(dy) > r) continue;
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= width || y >= height) continue;
                const i = y * width + x;
                visible[i] = 1;
                explored[i] = 1;
            }
        }
    };

    // Recompute live sight (cities + the scout's tile) and retarget each tile's haze.
    // Only tiles whose target changed join the easing set, so a moving scout costs a
    // thin ring of work per tile-change.
    const retarget = (sx: number, sy: number): void => {
        visible.fill(0);
        for (const c of cities) stampSight(c.x, c.y, CITY_SIGHT);
        stampSight(sx, sy, SCOUT_SIGHT);
        for (let i = 0; i < width * height; i++) {
            const tgt = visible[i] ? 0 : explored[i] ? EXPLORED_ALPHA : UNEXPLORED_ALPHA;
            if (tgt !== hazeTarget[i]) {
                hazeTarget[i] = tgt;
                active.add(i);
            }
        }
    };

    // Ease every transitioning tile toward its target, write the byte into the field,
    // and drop tiles once they arrive. Returns whether any byte changed (→ re-upload).
    const ease = (dtMs: number): boolean => {
        if (active.size === 0) return false;
        const step = dtMs / FOG_EASE_MS;
        for (const i of active) {
            const t = hazeTarget[i]!;
            let h = hazeCur[i]!;
            h = h < t ? Math.min(t, h + step) : Math.max(t, h - step);
            hazeCur[i] = h;
            field[i * 4] = Math.round(h * 255);
            if (h === t) active.delete(i);
        }
        return true;
    };

    let lastSx = -1;
    let lastSy = -1;
    let lastT = 0;

    return {
        update(view: FogView, sx: number, sy: number): void {
            const now = performance.now();
            const dtMs = lastT === 0 ? 16 : Math.min(100, now - lastT);
            lastT = now;
            if (lastSx === -1) {
                // First frame: snap straight to the sight target (no opening animation).
                retarget(sx, sy);
                for (const i of active) {
                    hazeCur[i] = hazeTarget[i]!;
                    field[i * 4] = Math.round(hazeCur[i]! * 255);
                }
                active.clear();
                uploadField();
            } else if (sx !== lastSx || sy !== lastSy) {
                retarget(sx, sy);
            }
            lastSx = sx;
            lastSy = sy;
            if (ease(dtMs)) uploadField();

            // Fullscreen quad centred on the canvas; the tint carries the world rectangle
            // currently on screen (a world point W draws at (W − view) · zoom, so screen
            // uv 0 is world `view` and the span is `canvas / zoom`).
            const w = view.w ?? (engine.canvas.width || 1);
            const h = view.h ?? (engine.canvas.height || 1);
            updateSprite2DIndex(layer, sprite, {
                positionPx: [w * 0.5, h * 0.5],
                sizePx: [w, h],
                color: [view.x, view.y, w / view.zoom, h / view.zoom],
                visible: true,
            });
        },
        dispose(): void {
            removeSpriteRendererLayer(sr, layer);
        },
    };
}
