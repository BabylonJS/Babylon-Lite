/**
 * Command feedback FX for the Freeciv demo — the "game feel" layer that makes
 * issuing orders feel responsive. Two GPU-shader effects on one custom-shader layer
 * (no engine changes, no assets):
 *
 *   • a scrolling **marching-ants ring** on the tile the scout is marching to, and
 *   • a quick expanding **ping ripple** wherever the player clicks to issue an order.
 *
 * Both are round (a circle in quad space → a flat ellipse on the iso ground, matching
 * the round mouse selector) and synthesised per-pixel in WGSL, animated for free off
 * `fx.time`. Each sprite carries its mode (1 ants / 2 ping) plus a phase and strength
 * in its `tint`, so one shader draws every variant. The layer sits on top of the world
 * (above the hover highlight) and is reprojected through the current view each frame.
 *
 * The selected-unit indicator is NOT here: the scout sprite itself pulses (see
 * `live.ts` `setScoutSelected`), which reads better than a ring around it.
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
import { TILE_H, TILE_W, isoCentre } from "./iso.js";

/** Render order: above the hover highlight (15) so command feedback reads on top. */
const FX_ORDER = 16;
/** Click-ping lifetime (ms) — a quick acknowledge ripple. */
const PING_LIFE_MS = 520;
/** How many pings can overlap (rapid clicks). */
const PING_POOL = 5;
/** Ping quad footprint (world px) — a bit over a tile so the ripple expands past it. */
const PING_W = TILE_W * 1.6;
const PING_H = TILE_H * 1.6;

/** Just the slice of the demo's view the reprojection needs. */
export interface CommandFxView {
    x: number;
    y: number;
    zoom: number;
}

/** Per-frame command state the FX layer renders. */
export interface CommandFxState {
    /** Tile the scout is marching to (marching-ants target), or `null` when idle. */
    dest: readonly [number, number] | null;
}

export interface CommandFx {
    /** Reproject + animate the marching-ants ring and live pings for the current view. */
    update: (view: CommandFxView, state: CommandFxState, dtMs: number) => void;
    /** Fire an expanding ping ripple centred on tile `(tx, ty)`. */
    ping: (tx: number, ty: number) => void;
    /** Remove the FX layer from the renderer. */
    dispose: () => void;
}

/**
 * Command-FX fragment (one custom-shader layer, many sprites). In scope: `in.uv`
 * (0..1 across the quad), `in.tint` (`.x` = mode 1 ants / 2 ping, `.y` = phase — age
 * 0..1 for a ping, `.z` = strength), `fx.time` (auto-accumulated seconds → scroll/
 * expand), and `L.opacityMul` (multiply the whole result). Geometry is the radial
 * distance `r = length(uv - 0.5)`: a circle in quad space, which on the tile-sized
 * (2:1) quad renders as a flat ellipse hugging the iso ground — a round selector.
 */
const FX_FRAGMENT = `
let mode = in.tint.x;
let phase = in.tint.y;
let strength = in.tint.z;
let p = in.uv - vec2<f32>(0.5, 0.5);
let r = length(p);
if (mode < 1.5) {
// Marching-ants destination: a dashed CIRCLE (an ellipse on the iso ground) scrolling
// around the target tile, sized to match the round mouse-hover selector (radius 0.38 so
// it sits inside the tile like the selector, not spilling toward the tile edges).
let line = smoothstep(0.04, 0.0, abs(r - 0.32));
let ang = atan2(p.y, p.x);
let dash = step(0.5, fract(ang * (7.0 / 3.14159265) - fx.time * 1.2));
let a = line * dash * strength;
if (a <= 0.01) { discard; }
return vec4<f32>(1.0, 0.94, 0.5, a) * L.opacityMul;
}
// Ping ripple: an expanding CIRCLE that fades as it grows (phase = age 0..1).
let rr = phase * 0.46;
let line = smoothstep(0.08, 0.0, abs(r - rr));
let a = line * (1.0 - phase) * strength;
if (a <= 0.01) { discard; }
return vec4<f32>(0.7, 0.96, 1.0, a) * L.opacityMul;
`;

/** Build the {@link CommandFx}: marching-ants (slot 0) and a ping pool (the rest), all
 * on one custom-shader layer added to `sr` at {@link FX_ORDER}. */
export function createCommandFx(engine: EngineContext, sr: SpriteRenderer): CommandFx {
    // 1×1 white atlas — every pixel is synthesised by the shader, the texture is ignored.
    const whiteTex = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
    const atlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: 1, cellHeightPx: 1, pivot: [0.5, 0.5] });
    const shader = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
    const layer = createSprite2DLayer(atlas, { capacity: 1 + PING_POOL, order: FX_ORDER, pivot: [0.5, 0.5], customShader: shader });
    addSpriteRendererLayer(sr, layer);

    // Slot 0 = marching-ants destination marker (shown only while marching). Added at full
    // size, hidden via the `visible` flag — never sizePx[0,0], which latches a sprite hidden.
    const antsIndex = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [TILE_W, TILE_H], frame: 0, color: [1, 0, 0.9, 1], visible: false });

    interface Ping {
        index: number;
        wx: number;
        wy: number;
        age: number;
        active: boolean;
    }
    const pings: Ping[] = [];
    for (let i = 0; i < PING_POOL; i++) {
        const index = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [PING_W, PING_H], frame: 0, color: [2, 0, 0, 1], visible: false });
        pings.push({ index, wx: 0, wy: 0, age: 0, active: false });
    }
    let pingCursor = 0;

    return {
        update(view: CommandFxView, state: CommandFxState, dtMs: number): void {
            const z = view.zoom;

            // Marching-ants destination marker — only while the scout is marching somewhere.
            if (state.dest) {
                const [dwx, dwy] = isoCentre(state.dest[0], state.dest[1]);
                updateSprite2DIndex(layer, antsIndex, {
                    positionPx: [(dwx - view.x) * z, (dwy - view.y) * z],
                    sizePx: [TILE_W * z, TILE_H * z],
                    color: [1, 0, 0.95, 1],
                    visible: true,
                });
            } else {
                updateSprite2DIndex(layer, antsIndex, { visible: false });
            }

            // Live ping ripples.
            for (const ping of pings) {
                if (!ping.active) continue;
                ping.age += dtMs;
                if (ping.age >= PING_LIFE_MS) {
                    ping.active = false;
                    updateSprite2DIndex(layer, ping.index, { visible: false });
                    continue;
                }
                updateSprite2DIndex(layer, ping.index, {
                    positionPx: [(ping.wx - view.x) * z, (ping.wy - view.y) * z],
                    sizePx: [PING_W * z, PING_H * z],
                    color: [2, ping.age / PING_LIFE_MS, 1, 1],
                    visible: true,
                });
            }
        },
        ping(tx: number, ty: number): void {
            const [wx, wy] = isoCentre(tx, ty);
            const ping = pings[pingCursor]!;
            pingCursor = (pingCursor + 1) % PING_POOL;
            ping.wx = wx;
            ping.wy = wy;
            ping.age = 0;
            ping.active = true;
        },
        dispose(): void {
            removeSpriteRendererLayer(sr, layer);
        },
    };
}
