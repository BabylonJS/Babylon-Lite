/**
 * Atmospheric clouds for the Freeciv demo — a single fullscreen, GPU-procedural
 * cloud field that drifts *over* the map (but under the minimap), plus a soft
 * cloud-shadow pass cast on the ground. All on Lite's own sprite path via a
 * per-layer custom fragment shader (no engine changes, no framegraph passes, no
 * assets).
 *
 * v2 (in-shader): instead of scattering pre-baked puff sprites, both the clouds
 * and their shadows are a single fullscreen quad each, coloured entirely by a WGSL
 * fragment that evaluates fractal-Brownian-motion (fBm) value noise per pixel. The
 * noise is sampled in **world space** (the quad's per-frame `tint` carries the
 * world rectangle currently on screen), so the field is pinned over the terrain and
 * pans with it; an additional `fx.time` wind term drifts the whole sheet for free.
 * Because the same noise function drives both passes, every shadow tracks the cloud
 * that casts it in perfect lockstep with zero CPU bookkeeping.
 *
 * Render order sits above the tilemap but below the minimap HUD, so the clouds pass
 * over the world yet never obscure the minimap. The shadow pass (order 38) sits
 * above the whole map — terrain, units/cities, fog — but just below the clouds
 * (order 40), so shadows read across the entire view rather than only the few
 * explored squares. The clouds live at a notional altitude: they only show on the
 * zoomed-out rungs (looking down from high up) and fade out as you zoom past 1, so
 * close-up the camera has dropped below them.
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
    type Sprite2DLayer,
    type SpriteRenderer,
} from "babylon-lite";

/** Just the slice of the demo's view the cloud field needs. */
export interface AtmosphereView {
    x: number;
    y: number;
    zoom: number;
    /** Render-target size in device pixels (the cloud/shadow quads fill it). Defaults to the canvas. */
    w?: number;
    h?: number;
    /** Continuous display zoom for the altitude fade (`zoom` is the seam-safe rung). */
    dz?: number;
}

export interface Atmosphere {
    /**
     * Reposition + re-anchor the fullscreen cloud/shadow quads for the current view/size.
     * `daylight` (1 = full day → 0 = night) fades the shadow pass out at night, when there's
     * no sun to cast it; the clouds themselves stay (lit ambiently / by the moon).
     */
    update: (view: AtmosphereView, daylight: number) => void;
    /** Remove the cloud + shadow layers from the renderer. */
    dispose: () => void;
}

// ── Tunables ────────────────────────────────────────────────────────────────

/** World-space → noise-space scale: one fBm base cell ≈ 1/CLOUD_SCALE world px. */
const CLOUD_SCALE = 1 / 440;
/** Clouds are fully visible at/below this zoom (the zoomed-out overview rungs). */
const CLOUD_FADE_LO = 1;
/** …and fully gone at/above this zoom — past 1 the camera drops below them. */
const CLOUD_FADE_HI = 2;

/** Render order: clouds above the map, shadows just below the clouds. */
const CLOUD_ORDER = 40;
const SHADOW_ORDER = 38;

// ── WGSL ──────────────────────────────────────────────────────────────────────

/**
 * Shared cloud/shadow fragment. In scope: `in.uv` (0..1 across the fullscreen
 * quad), `in.tint` (world rect on screen: `.xy` origin, `.zw` span — both already
 * multiplied by CLOUD_SCALE), `fx.time` (auto-accumulated seconds → wind drift),
 * `fx.params` (`.x` = zoom visibility, `.y` = mode: 0 cloud / 1 shadow), and
 * `L.opacityMul` (a vec4 — must multiply the whole result, never just alpha).
 *
 * fBm value noise is inlined into the octave loop (WGSL forbids nested fn defs in a
 * spliced fragment body). The shadow pass samples the same field shifted toward the
 * down-sun side so it reads as the cloud's shadow on the ground.
 */
const CLOUD_FRAGMENT = `
let wind = vec2<f32>(fx.time * 0.042, fx.time * 0.025);
var sp = in.tint.xy + in.uv * in.tint.zw + wind;
let isShadow = fx.params.y > 0.5;
if (isShadow) { sp = sp + vec2<f32>(0.42, 0.32); }
var p = sp;
var amp = 0.5;
var sum = 0.0;
var norm = 0.0;
for (var o = 0; o < 5; o = o + 1) {
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
let cover = smoothstep(0.54, 0.80, f);
let vis = fx.params.x;
let a = cover * vis;
if (a <= 0.001) { discard; }
if (isShadow) {
return vec4<f32>(0.03, 0.05, 0.13, a * 0.52) * L.opacityMul;
}
return vec4<f32>(0.84, 0.88, 0.96, a * 0.52) * L.opacityMul;
`;

// ── Build ──────────────────────────────────────────────────────────────────────

/** A fullscreen quad coloured by {@link CLOUD_FRAGMENT}; `mode` picks cloud vs shadow. */
interface CloudPass {
    layer: Sprite2DLayer;
    sprite: number;
    mode: number; // 0 = cloud, 1 = shadow
}

function buildPass(
    sr: SpriteRenderer,
    order: number,
    mode: number,
    atlas: ReturnType<typeof createGridSpriteAtlas>,
    shader: ReturnType<typeof createSprite2DCustomShader>,
): CloudPass {
    const layer = createSprite2DLayer(atlas, { capacity: 1, order, pivot: [0.5, 0.5], customShader: shader });
    addSpriteRendererLayer(sr, layer);
    const sprite = addSprite2DIndex(layer, {
        positionPx: [0, 0],
        sizePx: [1, 1],
        frame: 0,
        color: [0, 0, 0, 0],
        visible: false,
    });
    return { layer, sprite, mode };
}

/** Build the {@link Atmosphere}: one in-shader cloud field + a soft shadow pass. */
export function createAtmosphere(engine: EngineContext, sr: SpriteRenderer): Atmosphere {
    // A 1×1 white atlas is fine here: the custom shader synthesises every pixel and
    // never samples the atlas, so the plain-path "tiny texture doesn't render" trap
    // (which only bites the stock textured shader) does not apply.
    const tex = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
    const atlas = createGridSpriteAtlas(tex, { cellWidthPx: 1, cellHeightPx: 1, pivot: [0.5, 0.5] });
    // One shader descriptor drives both passes; each layer carries its own fx.params,
    // so `.y` (mode) switches the same WGSL between the light cloud and dark shadow.
    const shader = createSprite2DCustomShader({ fragment: CLOUD_FRAGMENT });

    const shadow = buildPass(sr, SHADOW_ORDER, 1, atlas, shader);
    const clouds = buildPass(sr, CLOUD_ORDER, 0, atlas, shader);

    function place(
        pass: CloudPass,
        originX: number,
        originY: number,
        spanX: number,
        spanY: number,
        w: number,
        h: number,
        vis: number,
    ): void {
        if (vis <= 0) {
            updateSprite2DIndex(pass.layer, pass.sprite, { visible: false });
            return;
        }
        // Fullscreen quad centred on the canvas. The tint carries the world rectangle
        // currently on screen (scaled into noise space) so the field stays anchored to
        // the terrain and pans with it; `fx.time` adds the independent wind drift.
        updateSprite2DIndex(pass.layer, pass.sprite, {
            positionPx: [w * 0.5, h * 0.5],
            sizePx: [w, h],
            color: [originX, originY, spanX, spanY],
            visible: true,
        });
        setSprite2DShaderParams(pass.layer, [vis, pass.mode, 0, 0]);
    }

    return {
        update(view: AtmosphereView, daylight: number): void {
            const w = view.w ?? (engine.canvas.width || 1);
            const h = view.h ?? (engine.canvas.height || 1);
            // Clouds live at "altitude": visible only zoomed out, fading out as you zoom in
            // past 1. Use the CONTINUOUS display zoom (`dz`) for the fade — `view.zoom` is the
            // rung the world rasterises at, which would make clouds vanish abruptly at a rung.
            const dz = view.dz ?? view.zoom;
            const vis = Math.max(0, Math.min(1, (CLOUD_FADE_HI - dz) / (CLOUD_FADE_HI - CLOUD_FADE_LO)));
            // World rectangle on screen: a world point W draws at (W − view) · zoom, so
            // screen-left (uv 0) is world `view.x` and the span is `canvas / zoom`.
            const originX = view.x * CLOUD_SCALE;
            const originY = view.y * CLOUD_SCALE;
            const spanX = (w / view.zoom) * CLOUD_SCALE;
            const spanY = (h / view.zoom) * CLOUD_SCALE;
            // Shadows need the sun: fade them with daylight so they vanish at night.
            place(shadow, originX, originY, spanX, spanY, w, h, vis * daylight);
            place(clouds, originX, originY, spanX, spanY, w, h, vis);
        },
        dispose(): void {
            removeSpriteRendererLayer(sr, clouds.layer);
            removeSpriteRendererLayer(sr, shadow.layer);
        },
    };
}
