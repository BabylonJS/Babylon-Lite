/**
 * Atmospheric clouds for the Freeciv demo — two layers of slowly drifting
 * procedural clouds that float *over* the map (but under the minimap), giving the
 * scene a sense of weather and depth. All on Lite's own sprite path (no engine
 * changes, no shader passes, no assets).
 *
 * The clouds are procedural: at load we synthesise a small sheet of distinct soft
 * cloud "puffs" in plain JS, upload it with `createTexture2DFromPixels`, and
 * scatter a handful of those puffs at random positions/sizes as pure-2D HUD
 * sprites. They drift on their own and parallax against the map pan (slower than
 * the terrain → reads as depth). Because each puff is an individually placed blob
 * (random variant, position and size) rather than a repeated grid cell, there is
 * no visible tiling. Two layers at different scales/speeds add a second parallax
 * cue. Kept subtle so the map stays legible.
 *
 * Render order sits above the tilemap but below the minimap HUD, so the clouds
 * pass over the world yet never obscure the minimap. The clouds live at a notional
 * altitude: they only show on the two zoomed-out rungs (½ and 1, looking down from
 * high up) and fade out as you zoom past 1, so close-up the camera has dropped
 * below them. Their size tracks zoom so they read as pinned over the world, not
 * stuck to the screen.
 */

import {
    addSprite2DIndex,
    addSpriteRendererLayer,
    createGridSpriteAtlas,
    createSprite2DLayer,
    createTexture2DFromPixels,
    removeSpriteRendererLayer,
    updateSprite2DIndex,
    type EngineContext,
    type Sprite2DLayer,
    type SpriteRenderer,
} from "babylon-lite";

/** Just the slice of the demo's view the parallax needs. */
export interface AtmosphereView {
    x: number;
    y: number;
    zoom: number;
}

export interface Atmosphere {
    /** Advance the drift and reposition the clouds for the current view/size. */
    update: (view: AtmosphereView) => void;
    /** Remove the cloud layers from the renderer. */
    dispose: () => void;
}

/** One scattered, drifting cloud puff. */
interface Puff {
    index: number; // sprite index in the layer
    u: number; // home position, fraction of the wrap span [0,1)
    v: number;
    size: number; // on-screen size in device px
    alpha: number; // per-puff opacity multiplier
}

/** One drifting cloud sheet: a set of randomly scattered puffs. */
interface CloudField {
    layer: Sprite2DLayer;
    puffs: Puff[];
    maxSize: number; // largest puff (sets the wrap margin)
    speed: [number, number]; // drift, device px per ms
    parallax: number; // fraction of map pan applied
    offset: [number, number]; // accumulated drift phase
}

// ── Procedural texture synthesis ─────────────────────────────────────────────

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/** Hash a lattice point to [0,1) (non-periodic — puffs fade at their own edges). */
function latticeHash(ix: number, iy: number): number {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}

/** Value noise at `(x, y)` over an open (non-tiling) integer lattice. */
function valueNoise(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const v00 = latticeHash(x0, y0);
    const v10 = latticeHash(x0 + 1, y0);
    const v01 = latticeHash(x0, y0 + 1);
    const v11 = latticeHash(x0 + 1, y0 + 1);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
}

/** Fractal Brownian motion in `[0,1)` (open lattice; `seed` shifts the field). */
function fbm(x: number, y: number, baseFreq: number, seedX: number, seedY: number): number {
    let amp = 0.5;
    let freq = baseFreq;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < 5; o++) {
        sum += amp * valueNoise(x * freq + seedX, y * freq + seedY);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
    }
    return sum / norm;
}

/**
 * A `cols×rows` grid of distinct, soft cloud puffs in one RGBA sheet. Each cell is
 * fBm clouds (a different region of noise per cell) multiplied by a radial falloff
 * so the blob fades to nothing at the cell edge — that way scattered puffs read as
 * isolated clouds with no rectangular seams.
 */
function makePuffSheet(cols: number, rows: number, cell: number, baseFreq: number, maxAlpha: number): Uint8Array {
    const W = cols * cell;
    const H = rows * cell;
    const px = new Uint8Array(W * H * 4);
    for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
            const seedX = (cx + cy * cols) * 13.37;
            const seedY = (cx * 7 + cy * 131 + 5) * 2.71;
            for (let y = 0; y < cell; y++) {
                for (let x = 0; x < cell; x++) {
                    const nx = x / cell;
                    const ny = y / cell;
                    const d = fbm(nx, ny, baseFreq, seedX, seedY);
                    // Radial fade from the cell centre → isolated, seamless blob.
                    const rx = nx * 2 - 1;
                    const ry = ny * 2 - 1;
                    const r = Math.sqrt(rx * rx + ry * ry);
                    const fall = smooth(Math.max(0, Math.min(1, (1 - r) / 0.55)));
                    // Puffy: nothing below `lo`, ramping to full by `hi`.
                    const lo = 0.42;
                    const hi = 0.8;
                    const a = Math.max(0, Math.min(1, (d - lo) / (hi - lo)));
                    const alpha = smooth(a) * fall * maxAlpha;
                    const o = ((cy * cell + y) * W + (cx * cell + x)) * 4;
                    px[o] = 206;
                    px[o + 1] = 220;
                    px[o + 2] = 240;
                    px[o + 3] = Math.round(alpha * 255);
                }
            }
        }
    }
    return px;
}

// ── Build ─────────────────────────────────────────────────────────────────────

/** Puff-sheet layout: a small grid of distinct cloud blobs to draw variety from. */
const PUFF_COLS = 4;
const PUFF_ROWS = 4;
const PUFF_CELL = 192;
const PUFF_VARIANTS = PUFF_COLS * PUFF_ROWS;

/** Zoom at which clouds are drawn at their authored size (the wider overview rung). */
const CLOUD_REF_ZOOM = 1;
/** Clouds are fully visible at/below this zoom (the two zoomed-out rungs: ½ and 1). */
const CLOUD_FADE_LO = 1;
/** …and fully gone at/above this zoom — past 1 the camera drops below them. */
const CLOUD_FADE_HI = 2;

/** Tiny deterministic RNG (mulberry32) so the cloud scatter replays identically. */
function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildCloudField(
    engine: EngineContext,
    sr: SpriteRenderer,
    order: number,
    count: number,
    sizeMin: number,
    sizeMax: number,
    baseFreq: number,
    maxAlpha: number,
    speed: [number, number],
    parallax: number,
    seed: number,
): CloudField {
    const sheet = makePuffSheet(PUFF_COLS, PUFF_ROWS, PUFF_CELL, baseFreq, maxAlpha);
    const tex = createTexture2DFromPixels(engine, sheet, PUFF_COLS * PUFF_CELL, PUFF_ROWS * PUFF_CELL);
    const atlas = createGridSpriteAtlas(tex, { cellWidthPx: PUFF_CELL, cellHeightPx: PUFF_CELL, pivot: [0.5, 0.5] });
    const layer = createSprite2DLayer(atlas, { capacity: count, order, pivot: [0.5, 0.5] });
    addSpriteRendererLayer(sr, layer);

    const rng = makeRng(seed);
    const puffs: Puff[] = [];
    for (let i = 0; i < count; i++) {
        const size = sizeMin + (sizeMax - sizeMin) * rng();
        const frame = Math.floor(rng() * PUFF_VARIANTS) % PUFF_VARIANTS;
        const alpha = 0.7 + 0.3 * rng();
        const index = addSprite2DIndex(layer, {
            positionPx: [0, 0],
            sizePx: [size, size],
            frame,
            color: [1, 1, 1, alpha],
            visible: false,
        });
        puffs.push({ index, u: rng(), v: rng(), size, alpha });
    }
    return { layer, puffs, maxSize: sizeMax, speed, parallax, offset: [0, 0] };
}

/** Build the {@link Atmosphere}: two layers of subtly drifting clouds. */
export function createAtmosphere(engine: EngineContext, sr: SpriteRenderer): Atmosphere {
    // Two cloud sheets drifting over the map: a big, faint, slow far layer and a
    // smaller, slightly stronger, faster near layer. Different scales + speeds add
    // depth; the scattered placement keeps them from ever looking tiled. Orders sit
    // above the tilemap (<16) but below the minimap HUD (100) so clouds pass over
    // the world yet never cover the minimap. Kept subtle so the map reads clearly.
    // Parallax is -1: the clouds track the world 1:1 (terrain draws at world − view,
    // so the phase subtracts the pan to move with the ground rather than against it).
    const far = buildCloudField(engine, sr, 40, 16, 320, 520, 3, 0.14, [0.0045, 0.0022], -1, 0x9e3779b1);
    const near = buildCloudField(engine, sr, 41, 14, 200, 340, 5, 0.18, [0.011, 0.006], -1, 0x85ebca77);

    let last = performance.now();

    function placeField(
        f: CloudField,
        view: AtmosphereView,
        w: number,
        h: number,
        dt: number,
        sizeScale: number,
        vis: number,
    ): void {
        // Drift always advances (so re-entering a cloudy zoom looks continuous) even
        // when the layer is currently hidden.
        f.offset[0] += f.speed[0] * dt;
        f.offset[1] += f.speed[1] * dt;
        if (vis <= 0) {
            for (const p of f.puffs) updateSprite2DIndex(f.layer, p.index, { visible: false });
            return;
        }
        // Advance drift; fold the map pan in at a fraction (parallax). Each puff wraps
        // independently across a span a little larger than the screen so it slides off
        // one edge and reappears on the other without any grid pattern. Puff size (and
        // therefore the wrap margin) scales with zoom so the clouds feel pinned at a
        // fixed altitude over the world rather than to the screen.
        const m = f.maxSize * sizeScale;
        const spanX = w + 2 * m;
        const spanY = h + 2 * m;
        const phaseX = f.offset[0] + view.x * f.parallax;
        const phaseY = f.offset[1] + view.y * f.parallax;
        for (const p of f.puffs) {
            const x = ((((p.u * spanX + phaseX) % spanX) + spanX) % spanX) - m;
            const y = ((((p.v * spanY + phaseY) % spanY) + spanY) % spanY) - m;
            const s = p.size * sizeScale;
            updateSprite2DIndex(f.layer, p.index, {
                positionPx: [x, y],
                sizePx: [s, s],
                color: [1, 1, 1, p.alpha * vis],
                visible: true,
            });
        }
    }

    return {
        update(view: AtmosphereView): void {
            const now = performance.now();
            const dt = Math.min(100, now - last);
            last = now;
            const w = engine.canvas.width || 1;
            const h = engine.canvas.height || 1;
            // Clouds live at "altitude": visible only on the two zoomed-out rungs
            // (½ and 1, looking down from high up), fading out as you zoom in past 1
            // so the camera drops below them. Their size tracks zoom, anchored so
            // they're full-size at zoom 1 and half that at ½.
            const vis = Math.max(0, Math.min(1, (CLOUD_FADE_HI - view.zoom) / (CLOUD_FADE_HI - CLOUD_FADE_LO)));
            const sizeScale = view.zoom / CLOUD_REF_ZOOM;
            placeField(far, view, w, h, dt, sizeScale, vis);
            placeField(near, view, w, h, dt, sizeScale, vis);
        },
        dispose(): void {
            removeSpriteRendererLayer(sr, far.layer);
            removeSpriteRendererLayer(sr, near.layer);
        },
    };
}
