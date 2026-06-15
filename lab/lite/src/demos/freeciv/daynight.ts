/**
 * Day/night cycle + city lights for the Freeciv demo — a slow, looping sun cycle
 * that grades the whole map from bright noon → warm dusk → cool midnight → dawn,
 * while every city blooms a warm glow that fades in after sunset. Pure-2D sprite
 * path, no engine changes, no assets:
 *
 *   • The grade is a single screen-space quad drawn with straight-alpha "over"
 *     blending (the default mode). Each frame it fades a dark, cool-tinted wash in
 *     over everything beneath it (terrain, sea, clouds, backdrop) at once — a free
 *     full-screen night grade from one sprite. (An alpha wash, not a multiply: it
 *     lays a translucent tint over the scene rather than multiplying its colour.)
 *   • The city lights are world-space quads drawn with ADDITIVE blend, so the warm
 *     glow *adds* light over the (now darkened) rooftops — reading as lit windows
 *     at night rather than a flat decal. This is the blend-mode showcase.
 *
 * Both layers sit above the clouds but below the vignette/minimap HUD. The grade is
 * pinned to the viewport (restretched to the canvas each frame); the lights are
 * reprojected from each city's world position through the current view, matching
 * the snapped transform the tiles render with closely enough that soft glows never
 * visibly drift.
 */

import {
    addSprite2DIndex,
    addSpriteRendererLayer,
    createGridSpriteAtlas,
    createSprite2DLayer,
    createTexture2DFromPixels,
    removeSpriteRendererLayer,
    spriteBlendAdditive,
    updateSprite2DIndex,
    type EngineContext,
    type SpriteRenderer,
} from "babylon-lite";
import { TILE_H, isoCentre } from "./iso.js";
import type { GameMap } from "./worldgen.js";

/** Just the slice of the demo's view the reprojection needs. */
export interface DayNightView {
    x: number;
    y: number;
    zoom: number;
    /** Render-target size in device pixels (the grade quad fills it). Defaults to the canvas. */
    w?: number;
    h?: number;
}

export interface DayNight {
    /** Advance the cycle and update the grade + city lights for the current view. */
    update: (view: DayNightView) => void;
    /** Current sunlight, `1` at full day → `0` at night (for sun-driven effects like shadows). */
    daylight: () => number;
    /** Remove the grade + lights layers from the renderer. */
    dispose: () => void;
}

/** Milliseconds to transition all the way from full day to full night (or back). */
const CYCLE_MS = 5000;
/** Warm colour the city lights emit (additive, so values are light, not paint). */
const LIGHT_RGB: [number, number, number] = [1.0, 0.82, 0.5];
/** Radial glow texture resolution (square, stretched per city). */
const GLOW_TEX = 64;

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

function clamp01(t: number): number {
    return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** A `GLOW_TEX²` white radial: opaque core fading to nothing at the rim (tinted warm
 * per-city at draw time; additive blend turns it into emitted light). */
function makeGlow(): Uint8Array {
    const px = new Uint8Array(GLOW_TEX * GLOW_TEX * 4);
    for (let y = 0; y < GLOW_TEX; y++) {
        for (let x = 0; x < GLOW_TEX; x++) {
            const dx = (x / (GLOW_TEX - 1) - 0.5) * 2;
            const dy = (y / (GLOW_TEX - 1) - 0.5) * 2;
            const d = Math.hypot(dx, dy);
            let a = clamp01(1 - d);
            a = a * a; // tighten the core so the glow reads as a point of light
            const o = (y * GLOW_TEX + x) * 4;
            px[o] = 255;
            px[o + 1] = 255;
            px[o + 2] = 255;
            px[o + 3] = Math.round(a * 255);
        }
    }
    return px;
}

/** Build the {@link DayNight} grade + city-light layers. */
export function createDayNight(engine: EngineContext, sr: SpriteRenderer, world: GameMap): DayNight {
    // ── Screen-space night overlay (alpha) ────────────────────────────────────
    // A solid-white texture stretched over the whole canvas, tinted a dark colour
    // and faded in by the cycle's alpha — an "over" wash that cools/darkens the
    // scene at night and warms it at the horizon. Order 45: above the clouds
    // (40/41), below the vignette (50) and minimap (100). The texture is a full
    // 256² (matching the proven vignette) — a tiny texture silently fails to render
    // on the plain (non-custom-shader) sprite path on some GPUs.
    const SOLID = 256;
    const whiteTex = createTexture2DFromPixels(engine, new Uint8Array(SOLID * SOLID * 4).fill(255), SOLID, SOLID);
    const whiteAtlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: SOLID, cellHeightPx: SOLID, pivot: [0.5, 0.5] });
    const gradeLayer = createSprite2DLayer(whiteAtlas, { capacity: 1, order: 45, pivot: [0.5, 0.5] });
    addSpriteRendererLayer(sr, gradeLayer);
    // Add at full canvas size with the cycle's starting (clear) tint, not sizePx
    // [0,0] — a zero initial size can latch a sprite hidden on the plain path.
    const gradeIndex = addSprite2DIndex(gradeLayer, {
        positionPx: [(engine.canvas.width || 1) / 2, (engine.canvas.height || 1) / 2],
        sizePx: [engine.canvas.width || 1, engine.canvas.height || 1],
        color: [0, 0, 0, 0],
    });

    // ── World-space city lights (additive) ────────────────────────────────────
    const glowTex = createTexture2DFromPixels(engine, makeGlow(), GLOW_TEX, GLOW_TEX);
    const glowAtlas = createGridSpriteAtlas(glowTex, { cellWidthPx: GLOW_TEX, cellHeightPx: GLOW_TEX, pivot: [0.5, 0.5] });
    const lightLayer = createSprite2DLayer(glowAtlas, { capacity: Math.max(1, world.cities.length), order: 46, pivot: [0.5, 0.5], blendMode: spriteBlendAdditive });
    addSpriteRendererLayer(sr, lightLayer);

    interface Light {
        index: number;
        wx: number;
        wy: number;
        base: number; // glow diameter in world px at zoom 1
        intensity: number; // peak additive strength
    }
    const lights: Light[] = world.cities.map((c) => {
        const [wx, wy] = isoCentre(c.x, c.y);
        return {
            index: addSprite2DIndex(lightLayer, { positionPx: [0, 0], sizePx: [0, 0], color: [LIGHT_RGB[0], LIGHT_RGB[1], LIGHT_RGB[2], 0], visible: false }),
            wx,
            wy: wy - TILE_H * 0.3, // lift over the building mass (city pivot is bottom)
            base: 60 + c.size * 8,
            intensity: Math.min(0.95, 0.55 + c.size * 0.05),
        };
    });

    let last = performance.now();
    // `level` in [0,1]: 0 = full day (noon), 1 = full night (midnight). There is no
    // automatic loop — the scene rests at whichever end it last reached. Pressing N
    // toggles `target` to the opposite end; `level` then eases there over `CYCLE_MS`
    // and STAYS, so night persists until the user presses N again.
    let level = 0;
    let target = 0;
    let day = 1; // current sunlight, 1 day → 0 night; read by `daylight()`

    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.repeat) return;
        if (e.key === "n" || e.key === "N") {
            target = target > 0.5 ? 0 : 1;
        }
    };
    window.addEventListener("keydown", onKeyDown);

    return {
        update(view: DayNightView): void {
            const now = performance.now();
            const dt = Math.min(100, now - last);
            last = now;
            // Ease `level` toward `target` (day 0 ↔ night 1) over `CYCLE_MS`.
            const step = dt / CYCLE_MS;
            if (level < target) level = Math.min(target, level + step);
            else if (level > target) level = Math.max(target, level - step);
            const sun = Math.cos(level * Math.PI); // +1 day (level 0) … -1 night (level 1)
            day = clamp01(sun); // 1 in full daylight, 0 once the sun is below the horizon

            // Night overlay (alpha "over"): a cool dark-blue wash whose OPACITY ramps strictly
            // linearly with `level` (which itself eases linearly in time), so scene brightness
            // changes at a constant rate. The overlay COLOUR is constant, so every channel is a
            // straight-line blend toward the night blue — provably monotonic, no pulse.
            //
            // The previous version mixed in a warm dusk tint that PEAKED at the horizon crossing.
            // Even once its alpha was made monotonic, that warm bump still lifted the red channel
            // of the blended scene mid-transition and back down — the subtle brighten-then-darken
            // "pulse" (in both directions) the user saw. A constant colour removes it entirely.
            const or = 0.04;
            const og = 0.06;
            const ob = 0.18;
            const alpha = level * 0.62; // 0 at full day → 0.62 at midnight, linear in time
            const gw = view.w ?? (engine.canvas.width || 1);
            const gh = view.h ?? (engine.canvas.height || 1);
            updateSprite2DIndex(gradeLayer, gradeIndex, {
                positionPx: [gw / 2, gh / 2],
                sizePx: [gw, gh],
                color: [or, og, ob, alpha],
            });

            // City lights fade in from dusk; warm up to full at deep night.
            const lit = smooth(clamp01((-sun + 0.15) / 0.5));
            const z = view.zoom;
            for (const l of lights) {
                if (lit <= 0) {
                    updateSprite2DIndex(lightLayer, l.index, { visible: false });
                    continue;
                }
                const s = l.base * z;
                const sx = (l.wx - view.x) * z;
                const sy = (l.wy - view.y) * z;
                updateSprite2DIndex(lightLayer, l.index, {
                    positionPx: [sx, sy],
                    sizePx: [s, s],
                    color: [LIGHT_RGB[0], LIGHT_RGB[1], LIGHT_RGB[2], lit * l.intensity],
                    visible: true,
                });
            }
        },
        daylight: () => day,
        dispose(): void {
            window.removeEventListener("keydown", onKeyDown);
            removeSpriteRendererLayer(sr, gradeLayer);
            removeSpriteRendererLayer(sr, lightLayer);
        },
    };
}
