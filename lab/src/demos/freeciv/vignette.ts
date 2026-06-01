/**
 * Screen-space vignette for the Freeciv demo — a single dark, feathered radial
 * that darkens the screen toward its corners so the empty "void" around the iso
 * island fades into shadow instead of showing the recognisable Mercator backdrop
 * at the edges. It frames the map (which sits centred) without touching the bright
 * centre. Pure-2D HUD sprite (no engine changes, no shaders, no assets).
 *
 * It lives in *screen* space (a HUD layer added straight to the renderer, never in
 * the panned `layers` array), so it stays pinned to the viewport as the map pans
 * and zooms. Each frame `update` just restretches the one sprite to the current
 * canvas size — the radial texture is square and gets squashed to the viewport's
 * aspect, which is exactly the elliptical falloff a vignette wants.
 *
 * Order sits above the tilemap and clouds but below the minimap HUD (100), so the
 * darkening passes over the world and weather yet never dims the minimap.
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

export interface Vignette {
    /** Restretch the vignette to the current canvas size. */
    update: () => void;
    /** Remove the vignette layer from the renderer. */
    dispose: () => void;
}

/** Near-black ocean shadow the corners fade toward (darker than the clear value). */
const SHADOW_RGB: [number, number, number] = [8, 18, 32];
/** Peak opacity at the extreme corners. */
const MAX_ALPHA = 0.7;
/** Radius (fraction of half-diagonal) held fully clear before the darkening ramps. */
const CLEAR_R = 0.5;
/** Texture resolution of the radial (square; stretched to the viewport aspect). */
const TEX = 256;

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/** A `TEX×TEX` RGBA radial: clear in the centre disc, ramping to dark at the corners. */
function makeVignette(): Uint8Array {
    const px = new Uint8Array(TEX * TEX * 4);
    for (let y = 0; y < TEX; y++) {
        for (let x = 0; x < TEX; x++) {
            const dx = (x / (TEX - 1) - 0.5) * 2; // -1 … 1
            const dy = (y / (TEX - 1) - 0.5) * 2;
            // Normalise so the corners (the longest reach) hit r = 1.
            const r = Math.hypot(dx, dy) / Math.SQRT2;
            const t = Math.max(0, Math.min(1, (r - CLEAR_R) / (1 - CLEAR_R)));
            const a = smooth(t) * MAX_ALPHA;
            const o = (y * TEX + x) * 4;
            px[o] = SHADOW_RGB[0];
            px[o + 1] = SHADOW_RGB[1];
            px[o + 2] = SHADOW_RGB[2];
            px[o + 3] = Math.round(a * 255);
        }
    }
    return px;
}

/** Build the {@link Vignette} HUD layer. */
export function createVignette(engine: EngineContext, sr: SpriteRenderer): Vignette {
    const tex = createTexture2DFromPixels(engine, makeVignette(), TEX, TEX);
    const atlas = createGridSpriteAtlas(tex, { cellWidthPx: TEX, cellHeightPx: TEX, pivot: [0.5, 0.5] });
    // Order 50: above the tilemap (<16) and clouds (40/41), below the minimap (100).
    const layer = createSprite2DLayer(atlas, { capacity: 1, order: 50, pivot: [0.5, 0.5] });
    addSpriteRendererLayer(sr, layer);
    const index = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [0, 0] });

    return {
        update(): void {
            const w = engine.canvas.width || 1;
            const h = engine.canvas.height || 1;
            updateSprite2DIndex(layer, index, {
                positionPx: [w / 2, h / 2],
                sizePx: [w, h],
            });
        },
        dispose(): void {
            removeSpriteRendererLayer(sr, layer);
        },
    };
}
