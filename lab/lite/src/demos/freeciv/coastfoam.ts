/**
 * Coast foam for the Freeciv demo — a band of breaking surf that hugs every
 * shoreline. Same "continuous field" trick as the fog (`fog.ts`) and the clouds
 * (`atmosphere.ts`): one fullscreen, world-anchored quad whose fragment shader reads
 * the land/ocean layout from a tiny per-tile mask texture and paints animated foam
 * wherever the sea meets the land. No per-tile sprites, no engine changes, no assets.
 *
 * The key idea: upload a `width × height` mask where land = 1 and ocean = 0, sampled
 * with **bilinear** filtering. Between a land cell and an ocean cell the sampled value
 * ramps smoothly 1 → 0, so the `0.5` iso-contour of that field *is* the coastline —
 * a single continuous curve with no diamond stair-stepping. Foam is drawn in a thin
 * band on the ocean side of that contour (where the field sits just below 0.5), with
 * a world-space fBm + `fx.time` rolling the surf in and out so it reads as living
 * waves breaking along the shore rather than a static outline.
 *
 * The mask never changes (the map is fixed), so it is uploaded once at build time and
 * the whole effect is GPU-driven thereafter — the demo's tick only re-anchors the
 * quad to the current view.
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
} from "babylon-lite";
import { TILE_H, TILE_W } from "./iso.js";
import type { GameMap } from "./worldgen.js";

/** Render order: above the ocean shimmer (0.5) and coast cells (1), below land terrain (2). */
const FOAM_ORDER = 1.5;
/** How far past the shoreline the foam band starts, in tiles. The beach autotile graphic bleeds
 * ~a quarter-tile into the ocean, so the band must clear it. Measured in the SAME tile units on
 * both axes (the Chebyshev metric below is axis-symmetric), so the band sits the same distance
 * off every straight coast regardless of its on-screen orientation. */
const FOAM_INSET = 0.42;
/** Width of the foam band on the ocean side of the shoreline, in tiles. */
const FOAM_BAND = 0.17;
/** World-pixel block the foam field snaps to, so its edge reads as chunky pixel-art, not a smooth curve. */
const FOAM_PX = 3;

/** Just the slice of the demo's view the foam field needs. */
export interface FoamView {
    x: number;
    y: number;
    zoom: number;
}

export interface CoastFoam {
    /** Re-anchor the fullscreen foam quad to the current view. */
    update: (view: FoamView) => void;
    /** Remove the foam layer from the renderer. */
    dispose: () => void;
}

/**
 * Foam fragment (one fullscreen quad). In scope: `in.uv` (0..1 across the quad),
 * `in.tint` (`.xy` = world-pixel origin on screen, `.zw` = world-pixel span on screen),
 * `fx.time` (auto-accumulated seconds → surf motion), `landTex`/`landSamp` (the per-tile
 * land mask, bilinear), and `L.opacityMul` (a vec4 — multiply the whole result).
 *
 * Per pixel: map the screen position back to a world pixel, **snap it to a chunky
 * FOAM_PX block** (so the foam edge is blocky pixel-art, matching the tileset), then invert
 * the isometric transform to a continuous tile coordinate. In tile space the land/ocean
 * boundary runs along tile EDGES, which are axis-aligned, so the distance to shore is computed
 * with a **Chebyshev (max-axis) metric** over the surrounding tile centres: this offsets the
 * blocky coast with SQUARE, tile-aligned corners instead of the rounded arcs a bilinear field
 * would give. Foam lives in a tight band `0 < d < FOAM_BAND` past the waterline; a world-space
 * fBm and `fx.time` roll crests across that band so it breaks like surf, the final alpha is
 * quantised into a few hard steps to stay crisp/pixelated, and a slow value-noise gate leaves
 * only some stretches of coast foamy at a time so it never reads as a continuous outline.
 */
const FOAM_FRAGMENT = `
let wpx0 = in.tint.xy + in.uv * in.tint.zw;
let wpx = (floor(wpx0 / FOAM_PX) + 0.5) * FOAM_PX;
let tx = wpx.x / ${TILE_W}.0 + wpx.y / ${TILE_H}.0;
let ty = wpx.y / ${TILE_H}.0 - wpx.x / ${TILE_W}.0;
let fuv = vec2<f32>((tx + 0.5) / FOAM_W, (ty + 0.5) / FOAM_H);
let lm = textureSampleLevel(landTex, landSamp, fuv, 0.0).r;
// Deep inland: no foam. Cheap early-out before the neighbourhood search below.
if (lm > 0.85) { discard; }
// Tile-aligned distance to shore (Chebyshev). The land/ocean boundary runs along tile EDGES,
// which in (tx,ty) tile space are axis-aligned; offsetting that blocky region with a Chebyshev
// (max-axis) distance keeps SQUARE, tile-aligned corners instead of the rounded arcs a bilinear
// field gives. Search the 3x3 block of tile centres around this point (sampling at an integer
// centre returns that tile's hard 0/1 land value) and take the nearest LAND cell by Chebyshev
// distance; subtract 0.5 so distance starts at the cell edge (the shoreline), not the centre.
let cti = floor(tx + 0.5);
let ctj = floor(ty + 0.5);
var best = 9.0;
for (var dj = -1; dj <= 1; dj = dj + 1) {
for (var di = -1; di <= 1; di = di + 1) {
let ci = cti + f32(di);
let cj = ctj + f32(dj);
let landc = textureSampleLevel(landTex, landSamp, vec2<f32>((ci + 0.5) / FOAM_W, (cj + 0.5) / FOAM_H), 0.0).r;
if (landc > 0.5) { best = min(best, max(abs(tx - ci), abs(ty - cj))); }
}
}
let d = (best - 0.5) - FOAM_INSET;
if (d <= 0.0 || d >= FOAM_BAND) { discard; }
let t = d / FOAM_BAND;
// World-space fBm so the surf breaks irregularly along the coast (not a uniform ring).
var p = wpx * 0.02 + vec2<f32>(fx.time * 0.015, fx.time * 0.01);
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
let e = fract(sin(dot(gi + vec2<f32>(1.0, 1.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
let n = mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
sum = sum + amp * n;
norm = norm + amp;
amp = amp * 0.5;
p = p * 2.0 + vec2<f32>(19.1, 7.7);
}
let f = sum / norm;
// Gate: a slow, low-frequency value noise so only SOME stretches of coast show waves at a
// time (real coasts are not uniformly foamy). This is what breaks up the continuous "outline"
// look. Whole patches of calm vs. wavy coast drift over time. The smoothstep window
// below decides how much coast stays calm (higher lo/hi = more calm water, fewer waves).
// Frequency sets the PATCH SIZE: higher = smaller, more numerous patches, so each separate
// coast statistically gets a few accents instead of one shore hogging them all while another
// stays bare. The time term drifts the patches ALONG the coast; keep it gentle — much slower
// than the crests' inward roll below — or the foam reads as blobs sliding sideways faster than
// the waves move toward shore. (Instantaneous coverage depends only on frequency + threshold,
// not drift, so a slow drift still distributes foam evenly; it just evolves it calmly.)
let gp = wpx * 0.014 + vec2<f32>(fx.time * 0.02, fx.time * 0.015);
let gi2 = floor(gp);
let gf2 = fract(gp);
let gu = gf2 * gf2 * (3.0 - 2.0 * gf2);
let ga = fract(sin(dot(gi2, vec2<f32>(127.1, 311.7))) * 43758.5453);
let gb = fract(sin(dot(gi2 + vec2<f32>(1.0, 0.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
let gc = fract(sin(dot(gi2 + vec2<f32>(0.0, 1.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
let ge = fract(sin(dot(gi2 + vec2<f32>(1.0, 1.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
let gate = mix(mix(ga, gb, gu.x), mix(gc, ge, gu.x), gu.y);
// High threshold so only the rare PEAKS of the noise pass: most of the coast stays calm/empty
// and foam appears here and there as a subtle accent, not a near-continuous border.
let gateMask = smoothstep(0.78, 0.92, gate);
// Each wave is a crest that sweeps from the open sea (t=1) IN toward the shore (t=0), so you
// read waves rolling in. Few, well-separated crests (t * 1.3) so they show as individual waves
// with clear water between them, not a packed foam line; the coast noise (f) offsets each
// stretch's phase so neighbouring waves break out of step. This inward roll should be the
// DOMINANT motion — clearly faster than the gate's lateral drift above.
let wave = fract(t * 1.3 + fx.time * 0.24 + f * 1.0);
// Sharp breaking crest with calm water trailing it and a clear gap before the next wave.
let crest = smoothstep(0.0, 0.1, wave) * smoothstep(0.34, 0.1, wave);
// Fade foam out right at the waterline (t->0) so there is NO permanent foam line hugging the
// coast, and out in the deep (t->1); the moving crests live in between.
let envelope = smoothstep(0.0, 0.2, t) * smoothstep(1.0, 0.72, t);
let foam = crest * envelope * gateMask * (0.7 + 0.3 * f);
// Quantise into hard steps so the foam stays crisp/pixelated (no soft gradient ramp).
var a2 = 0.0;
if (foam > 0.55) { a2 = 0.5; } else if (foam > 0.32) { a2 = 0.28; } else if (foam > 0.16) { a2 = 0.13; }
if (a2 <= 0.01) { discard; }
return vec4<f32>(0.82, 0.9, 0.96, a2) * L.opacityMul;
`;

/**
 * Build the {@link CoastFoam}: a fullscreen foam quad driven by {@link FOAM_FRAGMENT}
 * plus the static land mask it samples. Adds the layer to `sr` at {@link FOAM_ORDER}.
 */
export function createCoastFoam(engine: EngineContext, sr: SpriteRenderer, world: GameMap): CoastFoam {
    const { width, height } = world;

    // Static land mask: R = 255 on land, 0 on ocean; bilinear so the 0.5 contour traces
    // the coastline as a smooth curve. Uploaded once — the map never changes.
    const mask = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (world.isLand(x, y)) mask[(y * width + x) * 4] = 255;
        }
    }
    const landTex = createTexture2DFromPixels(engine, mask, width, height, { minFilter: "linear", magFilter: "linear" });

    // One fullscreen quad on a 1×1 white atlas (the shader synthesises every pixel and
    // never samples the atlas); the land mask is bound as the extra `land` texture.
    // FOAM_W / FOAM_H let the shader map a world pixel back to a tile coordinate.
    const whiteTex = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
    const atlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: 1, cellHeightPx: 1, pivot: [0.5, 0.5] });
    const fragment = `const FOAM_W = ${width}.0;\nconst FOAM_H = ${height}.0;\nconst FOAM_INSET = ${FOAM_INSET};\nconst FOAM_BAND = ${FOAM_BAND};\nconst FOAM_PX = ${FOAM_PX}.0;\n${FOAM_FRAGMENT}`;
    const shader = createSprite2DCustomShader({ fragment, extraTextures: [{ name: "land", texture: landTex }] });
    const layer = createSprite2DLayer(atlas, { capacity: 1, order: FOAM_ORDER, pivot: [0.5, 0.5], customShader: shader });
    addSpriteRendererLayer(sr, layer);
    const sprite = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [1, 1], frame: 0, color: [0, 0, 0, 0], visible: false });

    return {
        update(view: FoamView): void {
            // Fullscreen quad centred on the canvas; the tint carries the world rectangle
            // currently on screen (a world point W draws at (W − view) · zoom, so screen
            // uv 0 is world `view` and the span is `canvas / zoom`).
            const w = engine.canvas.width || 1;
            const h = engine.canvas.height || 1;
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
