/**
 * Unit dust trails for the Freeciv demo — a little puff of dust kicked up under the
 * scout as it walks, fading behind it like footprints on a dirt road. Pure sprite
 * path, no engine changes, no committed assets.
 *
 * Unlike the water/sky effects (which are GPU fields), a trail must LEAVE puffs behind
 * at fixed world points while the unit moves on — so this is a small CPU particle pool.
 * While the scout is mid-hop the module emits a puff every few frames at the scout's
 * ground point; each puff is a soft, chunky disc that grows, drifts up a touch and fades
 * over its short life, anchored in world space so the scout walks away from it. The puffs
 * are reprojected through the current view each frame (like the city lights in
 * `daynight.ts`), sitting just below the unit/city sprites so the scout treads over its
 * own dust, and below the day/night grade so the trail darkens at night for free.
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
    type SpriteRenderer,
} from "babylon-lite";
import { TILE_H } from "./iso.js";

/** Render order: above terrain/specials, below the city (10) + unit (11) sprites, so the
 * scout treads over its own dust; below the day/night grade (45) so it darkens at night. */
const DUST_ORDER = 9.5;
/** Dusty tan the puffs are tinted (plain-path tint multiplies the white puff texture). */
const DUST_RGB: [number, number, number] = [0.82, 0.76, 0.6];
/** Emit one puff this often (ms) while the scout is moving. */
const EMIT_MS = 95;
/** How long each puff lives (ms) before it has fully faded. */
const PUFF_LIFE_MS = 720;
/** Puff diameter in world px at zoom 1 (before its per-life growth). */
const PUFF_BASE_PX = 16;
/** Peak puff opacity (the alpha envelope scales to this). */
const DUST_PEAK = 0.5;
/** Drop the puff this far below the scout's ground centre, so it sits at its feet. */
const DUST_FOOT = TILE_H * 0.42;
/** Particle pool size (≈ PUFF_LIFE_MS / EMIT_MS active at once, plus headroom). */
const POOL = 18;
/** Puff texture resolution (kept small + nearest-filtered so it scales up chunky/pixel-art). */
const PUFF_TEX = 16;

/** Just the slice of the demo's view the reprojection needs. */
export interface DustView {
    x: number;
    y: number;
    zoom: number;
}

export interface Dust {
    /**
     * Advance the dust pool: emit a new puff under the scout while it's moving, age every
     * live puff, and reproject them through the current view. `dtMs` drives emission + decay.
     */
    update: (view: DustView, scoutWx: number, scoutWy: number, moving: boolean, dtMs: number) => void;
    /** Remove the dust layer from the renderer. */
    dispose: () => void;
}

/** A soft radial puff, alpha quantised into a few chunky rings so it reads as pixel-art
 * dust (white RGB; tinted dusty-tan at draw time, the alpha carries the shape). */
function makePuff(): Uint8Array {
    const px = new Uint8Array(PUFF_TEX * PUFF_TEX * 4);
    for (let y = 0; y < PUFF_TEX; y++) {
        for (let x = 0; x < PUFF_TEX; x++) {
            const dx = (x + 0.5) / PUFF_TEX - 0.5;
            const dy = (y + 0.5) / PUFF_TEX - 0.5;
            const d = Math.hypot(dx, dy) * 2; // 0 centre → ~1 at the rim
            const f = Math.max(0, 1 - d);
            const a = f > 0.66 ? 1 : f > 0.4 ? 0.6 : f > 0.18 ? 0.3 : 0; // hard rings
            const o = (y * PUFF_TEX + x) * 4;
            px[o] = 255;
            px[o + 1] = 255;
            px[o + 2] = 255;
            px[o + 3] = Math.round(a * 255);
        }
    }
    return px;
}

/** Build the {@link Dust} trail pool and add its layer to `sr`. */
export function createDust(engine: EngineContext, sr: SpriteRenderer): Dust {
    const tex = createTexture2DFromPixels(engine, makePuff(), PUFF_TEX, PUFF_TEX, { minFilter: "nearest", magFilter: "nearest" });
    const atlas = createGridSpriteAtlas(tex, { cellWidthPx: PUFF_TEX, cellHeightPx: PUFF_TEX, pivot: [0.5, 0.5] });
    const layer = createSprite2DLayer(atlas, { capacity: POOL, order: DUST_ORDER, pivot: [0.5, 0.5] });
    addSpriteRendererLayer(sr, layer);

    interface Puff {
        index: number;
        wx: number;
        wy: number;
        vx: number; // world px/ms drift
        vy: number;
        age: number;
        life: number;
        active: boolean;
    }
    const puffs: Puff[] = [];
    for (let i = 0; i < POOL; i++) {
        // Add at FULL size with visible:false (never sizePx[0,0], which latches a sprite
        // permanently hidden on the plain sprite path).
        const index = addSprite2DIndex(layer, {
            positionPx: [0, 0],
            sizePx: [PUFF_BASE_PX, PUFF_BASE_PX],
            frame: 0,
            color: [DUST_RGB[0], DUST_RGB[1], DUST_RGB[2], 0],
            visible: false,
        });
        puffs.push({ index, wx: 0, wy: 0, vx: 0, vy: 0, age: 0, life: 0, active: false });
    }

    // Deterministic per-puff jitter so the demo replays identically.
    let seed = 0x9e3779b9 | 0;
    const rnd = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    let emitAccum = 0;
    let cursor = 0;

    const spawn = (wx: number, wy: number): void => {
        const p = puffs[cursor]!;
        cursor = (cursor + 1) % POOL;
        p.wx = wx + (rnd() - 0.5) * 10;
        p.wy = wy + DUST_FOOT + (rnd() - 0.5) * 4;
        p.vx = (rnd() - 0.5) * 0.012;
        p.vy = -0.008 - rnd() * 0.01; // drift up as it dissipates
        p.age = 0;
        p.life = PUFF_LIFE_MS * (0.8 + rnd() * 0.5);
        p.active = true;
    };

    return {
        update(view: DustView, scoutWx: number, scoutWy: number, moving: boolean, dtMs: number): void {
            // Emit a steady stream of puffs only while the scout is actually walking.
            if (moving) {
                emitAccum += dtMs;
                while (emitAccum >= EMIT_MS) {
                    emitAccum -= EMIT_MS;
                    spawn(scoutWx, scoutWy);
                }
            } else {
                emitAccum = 0;
            }

            const z = view.zoom;
            for (const p of puffs) {
                if (!p.active) continue;
                p.age += dtMs;
                if (p.age >= p.life) {
                    p.active = false;
                    updateSprite2DIndex(layer, p.index, { visible: false });
                    continue;
                }
                const t = p.age / p.life;
                p.wx += p.vx * dtMs;
                p.wy += p.vy * dtMs;
                // Grow as it dissipates; alpha rises fast then fades to nothing.
                const grow = 1 + t * 1.6;
                const fadeIn = Math.min(1, t / 0.1);
                const fadeOut = 1 - Math.max(0, (t - 0.25) / 0.75);
                const alpha = fadeIn * fadeOut * DUST_PEAK;
                const sx = (p.wx - view.x) * z;
                const sy = (p.wy - view.y) * z;
                const s = PUFF_BASE_PX * grow * z;
                updateSprite2DIndex(layer, p.index, {
                    positionPx: [sx, sy],
                    sizePx: [s, s],
                    color: [DUST_RGB[0], DUST_RGB[1], DUST_RGB[2], alpha],
                    visible: true,
                });
            }
        },
        dispose(): void {
            removeSpriteRendererLayer(sr, layer);
        },
    };
}
