/**
 * Smooth-zoom present pass for the Freeciv demo.
 *
 * The isometric tiles are alpha-baked diamonds that only tessellate crack-free when
 * rasterised at an INTEGER zoom rung (one texel → a whole number of device pixels).
 * That is why the demo's logical zoom used to be quantised to a ladder. To get smooth,
 * continuous zoom we decouple the two scales:
 *
 *   1. The whole *world* `SpriteRenderer` is redirected to render into an offscreen
 *      render texture (`worldRt`) at the nearest seam-safe rung — perfect tessellation,
 *      no cracks. The render target is SUPERSAMPLED (≈2× the canvas) so that between
 *      rungs we sample MORE than one RT texel per screen pixel and *down*-scale, which
 *      keeps the pixel-art crisp instead of the blur an up-scale would give.
 *   2. A "present" `SpriteRenderer` owns a single full-screen quad whose atlas IS that
 *      render texture. Each frame it samples the sub-rectangle of the RT that corresponds
 *      to the current viewport and scales it to the canvas (linear filtering), so the
 *      *fractional* part of the zoom lives entirely in this image scale. One continuous
 *      bitmap scaling smoothly → zero inter-tile seams at any zoom.
 *   3. A third "HUD" `SpriteRenderer` draws screen-space overlays (vignette, minimap) onto
 *      the swapchain AFTER the present quad — unscaled and uncropped, on top of the map.
 *
 * The three renderers run in registration order world → present → HUD, so each runs after
 * the one before and composites over the finished result. Built entirely on the public
 * sprite API plus the opt-in offscreen-target capability (`createRenderTexture2D` +
 * `setSpriteRendererTarget`); no engine changes.
 */

import {
    addSprite2DIndex,
    createGridSpriteAtlas,
    createRenderTexture2D,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createSpriteRenderer,
    disposeSpriteRenderer,
    registerSpriteRenderer,
    setSprite2DShaderParams,
    setSpriteRendererTarget,
    unregisterSpriteRenderer,
    updateSprite2DIndex,
    type EngineContext,
    type Sprite2DLayer,
    type SpriteRenderer,
    type Texture2D,
} from "babylon-lite";

/**
 * Present fragment: sample the world render texture over a per-frame sub-rectangle.
 * `fx.params` = (uvScaleX, uvScaleY, uvOffsetX, uvOffsetY); `in.uv` (0..1 across the
 * full-screen quad) is remapped into the RT's UV space so only the viewport portion is
 * shown, scaled to fill the canvas. Linear sampling (the RT's default) makes the between-
 * rung down-scale smooth. `atlasTex`/`atlasSamp` are bound to the world RT.
 */
const PRESENT_FRAGMENT = `
let uv = in.uv * vec2<f32>(fx.params.x, fx.params.y) + vec2<f32>(fx.params.z, fx.params.w);
return textureSample(atlasTex, atlasSamp, uv) * in.tint * L.opacityMul;
`;

/** Supersample factor for the world render target (RT pixels per canvas pixel, each axis).
 * 2 covers the worst case: just past a rung, R/zoom approaches 2, so the viewport occupies
 * up to ~2× canvas RT pixels that are then down-scaled to the canvas. */
const SUPERSAMPLE = 2;

export interface Present {
    /** Current world render-target size in device pixels (≈ canvas × SUPERSAMPLE). */
    readonly width: number;
    readonly height: number;
    /** Swapchain HUD renderer (drawn last). Register screen-space overlay layers here. */
    readonly screen: SpriteRenderer;
    /** (Re)allocate the render target for a new canvas backing size and rewire the world renderer. */
    resize: (canvasW: number, canvasH: number) => void;
    /**
     * Point the present quad at the RT sub-rectangle `[srcX, srcX+srcW) × [srcY, srcY+srcH)`
     * (in RT device pixels) and stretch it across the whole canvas.
     */
    sync: (canvasW: number, canvasH: number, srcX: number, srcY: number, srcW: number, srcH: number) => void;
    /** Tear down GPU resources (does not retarget the world renderer). */
    dispose: () => void;
}

/**
 * Wire smooth-zoom presentation onto `worldSr` (which must already be registered). Returns a
 * {@link Present}; call {@link Present.resize} once with the initial canvas size, then
 * {@link Present.sync} each frame. Register HUD layers on {@link Present.screen}.
 */
export function createPresent(engine: EngineContext, worldSr: SpriteRenderer): Present {
    const shader = createSprite2DCustomShader({ fragment: PRESENT_FRAGMENT });

    // HUD renderer: created once, kept across resizes. `clear: false` so it composites over
    // the present quad (which already filled every pixel) instead of wiping it.
    const hudSr = createSpriteRenderer(engine, { layers: [], clear: false });
    let hudRegistered = false;

    let worldRt: Texture2D | null = null;
    let presentSr: SpriteRenderer | null = null;
    let presentLayer: Sprite2DLayer | null = null;
    let presentSprite = -1;
    let rtW = 0;
    let rtH = 0;

    const build = (canvasW: number, canvasH: number): void => {
        // Tear down the old present chain. The world renderer keeps rendering to the old RT
        // until we retarget it below, so order of operations is safe.
        if (presentSr) {
            disposeSpriteRenderer(presentSr); // unregisters + frees the present layer GPU
            presentSr = null;
            presentLayer = null;
            presentSprite = -1;
        }
        if (worldRt) {
            worldRt.texture.destroy();
            worldRt = null;
        }
        // Drop the HUD's registration so the rebuilt present pass re-inserts before it.
        if (hudRegistered) {
            unregisterSpriteRenderer(hudSr);
            hudRegistered = false;
        }

        rtW = Math.max(1, Math.round(canvasW * SUPERSAMPLE));
        rtH = Math.max(1, Math.round(canvasH * SUPERSAMPLE));
        worldRt = createRenderTexture2D(engine, rtW, rtH);
        const atlas = createGridSpriteAtlas(worldRt, { cellWidthPx: rtW, cellHeightPx: rtH, pivot: [0.5, 0.5] });
        presentLayer = createSprite2DLayer(atlas, { capacity: 1, pivot: [0.5, 0.5], customShader: shader });
        presentSprite = addSprite2DIndex(presentLayer, { positionPx: [canvasW / 2, canvasH / 2], sizePx: [canvasW, canvasH], frame: 0, visible: true });
        presentSr = createSpriteRenderer(engine, { layers: [presentLayer] }); // default clear: wipes the swapchain, then the opaque present quad fills it

        // Registration order is render order: worldSr (already first) → present → HUD.
        registerSpriteRenderer(presentSr);
        registerSpriteRenderer(hudSr);
        hudRegistered = true;

        setSpriteRendererTarget(worldSr, worldRt);
        setSprite2DShaderParams(presentLayer, [1, 1, 0, 0]);
    };

    return {
        get width(): number {
            return rtW;
        },
        get height(): number {
            return rtH;
        },
        get screen(): SpriteRenderer {
            return hudSr;
        },
        resize(canvasW: number, canvasH: number): void {
            if (canvasW < 1 || canvasH < 1) return;
            if (worldRt && Math.round(canvasW * SUPERSAMPLE) === rtW && Math.round(canvasH * SUPERSAMPLE) === rtH) return;
            build(canvasW, canvasH);
        },
        sync(canvasW: number, canvasH: number, srcX: number, srcY: number, srcW: number, srcH: number): void {
            if (!presentLayer || presentSprite < 0) return;
            updateSprite2DIndex(presentLayer, presentSprite, { positionPx: [canvasW / 2, canvasH / 2], sizePx: [canvasW, canvasH], visible: true });
            setSprite2DShaderParams(presentLayer, [srcW / rtW, srcH / rtH, srcX / rtW, srcY / rtH]);
        },
        dispose(): void {
            if (presentSr) disposeSpriteRenderer(presentSr);
            if (hudRegistered) unregisterSpriteRenderer(hudSr);
            disposeSpriteRenderer(hudSr);
            if (worldRt) worldRt.texture.destroy();
            presentSr = null;
            presentLayer = null;
            worldRt = null;
        },
    };
}
