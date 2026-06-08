/**
 * CRT / scanline post-process for the platformer demo (improvements #17).
 *
 * Implemented entirely through Babylon Lite's PUBLIC sprite API plus one small,
 * opt-in engine capability added for this effect: a `SpriteRenderer` can be
 * pointed at an offscreen render texture instead of the swapchain
 * (`setSpriteRendererTarget` + `createRenderTexture2D`). Both default to the
 * swapchain, so every other scene/demo is byte-for-byte unaffected and the code
 * tree-shakes away when unused.
 *
 * How it works:
 *   1. The game's scene `SpriteRenderer` is redirected to render into an offscreen
 *      colour texture (`sceneRt`) sized to the canvas backing store.
 *   2. A SECOND "present" `SpriteRenderer` owns a single full-screen quad whose
 *      atlas IS that scene texture, drawn with a CRT custom-shader fragment
 *      (barrel curvature + scanlines + aperture mask + chromatic aberration +
 *      vignette). It renders to the swapchain and is registered AFTER the scene
 *      renderer, so it runs second and samples the finished frame.
 *
 * Toggling off restores the direct-to-swapchain path (scene target = null, present
 * pass unregistered) for zero overhead.
 */

import {
    addSprite2DIndex,
    createGridSpriteAtlas,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createSpriteRenderer,
    createRenderTexture2D,
    disposeSpriteRenderer,
    registerSpriteRenderer,
    setSprite2DShaderParams,
    setSpriteRendererTarget,
    unregisterSpriteRenderer,
    updateSprite2DIndex,
    type EngineContext,
    type SpriteRenderer,
    type Texture2D,
} from "babylon-lite";

/**
 * CRT fragment for `createSprite2DCustomShader`.
 *
 * A faithful WGSL port of the technique in Aka's MIT-licensed **CRTFilter**
 * (https://github.com/Ichiaka/CRTFilter).
 * In source order: a very subtle barrel curve, chromatic aberration, fine grain,
 * a "squaring" contrast pass (multiply by a tear-shifted second sample), highlight
 * glow-bloom, a slow rolling signal-loss band, scrolling scanlines whose DC offset
 * also re-brightens the squared image, a gentle aperture mask, slight desaturation,
 * and a brightness/flicker grade. Deliberately has **no vignette** — the reference
 * keeps the picture bright edge-to-edge, which is what makes it read as "nice" rather
 * than "heavy". The whole effect is then cross-faded over the untouched scene by
 * `fx.params.x` so strength 0 is an exact passthrough (and the toggle can fade).
 *
 *   fx.params.x = strength (0 = passthrough scene, 1 = full CRT)
 *   fx.params.y = canvas aspect (width / height)
 *   fx.params.z = scanline cycles down the screen (≈ height / 6 → ~6 device-px pitch)
 *   fx.params.w = device width in px (aperture-mask pitch)
 */
export const CRT_FRAGMENT = `
let strength = fx.params.x;
let lines = fx.params.z;
let devW = fx.params.w;
let t = fx.time;

// Untouched scene, for the strength cross-fade (also restores edges as strength→0).
let sceneCol = textureSample(atlasTex, atlasSamp, in.uv).rgb;

// Subtle barrel curvature — the reference barely bends; corners stay on-screen so
// clamp-to-edge sampling means no black bezel.
let cc = in.uv - vec2<f32>(0.5, 0.5);
let d2 = dot(cc, cc);
let uv = in.uv + cc * d2 * 0.07;

// Chromatic aberration: split R/B horizontally.
let ab = 0.0016;
var col = vec3<f32>(
    textureSample(atlasTex, atlasSamp, uv + vec2<f32>(ab, 0.0)).r,
    textureSample(atlasTex, atlasSamp, uv).g,
    textureSample(atlasTex, atlasSamp, uv - vec2<f32>(ab, 0.0)).b
);

// Fine static grain.
let grain = (fract(sin(dot(uv, vec2<f32>(12.9898, 78.233)) + t) * 43758.5453) - 0.5) * 0.035;
col = col + vec3<f32>(grain);

// Horizontal tearing + "squaring" contrast: multiply by a second, slightly sheared
// sample. Darkens midtones (rebrightened by the scanline DC offset below) for punch.
let tuv = vec2<f32>(uv.x + sin(uv.y * 10.0 + t * 2.0) * 0.0006, uv.y);
col = col * textureSample(atlasTex, atlasSamp, tuv).rgb;

// Glow bloom on the highlights (phosphor spread).
col = col + 0.14 * smoothstep(vec3<f32>(0.4), vec3<f32>(1.0), col);

// Slow rolling signal-loss band.
col = col * (1.0 - 0.05 * abs(sin(uv.y * 50.0 + t * 2.0)));

// Scrolling scanlines. The 1.75 DC offset both modulates rows and compensates the
// squaring darkening; 0.5 amplitude is the visible line contrast.
col = col * (1.75 + 0.5 * sin(uv.y * lines * 6.2831853 + t * 4.0));

// Gentle vertical aperture mask (~3 device-px pitch).
col = col * (0.94 + 0.06 * sin(uv.x * devW * 2.0943951));

// Slight desaturation for a faded-tube look.
let lum = dot(col, vec3<f32>(0.299, 0.587, 0.114));
col = mix(vec3<f32>(lum), col, 0.82);

// Brightness grade + faint mains-hum flicker.
col = col * 0.92 * (1.0 + 0.01 * sin(t * 24.0));

// Cross-fade scene → CRT by strength.
col = mix(sceneCol, col, strength);

return vec4<f32>(col, 1.0) * in.tint * L.opacityMul;
`;

/** Live CRT post-process attached to a scene sprite renderer. */
export interface CrtPostProcess {
    /** Whether the CRT pass is currently active. */
    readonly enabled: boolean;
    /** Flip the effect on/off (rewires the scene target + present pass). */
    setEnabled(on: boolean): void;
    /** Toggle and return the new state. */
    toggle(): boolean;
    /**
     * Call once per frame with the current canvas backing-store size. Builds the
     * offscreen chain on first use and rebuilds it if the canvas resized; updates
     * the full-screen quad + shader params. No-op while disabled. (Animated terms
     * in the shader read the auto-driven `fx.time`, so no clock is passed in.)
     */
    sync(canvasWidth: number, canvasHeight: number): void;
}

/**
 * Wire a CRT post-process onto an already-registered scene `SpriteRenderer`.
 * Starts in `enabled` state (default true). The caller must drive {@link CrtPostProcess.sync}
 * each frame from its render/update loop.
 */
export function createCrtPostProcess(engine: EngineContext, scene: SpriteRenderer, enabled = true): CrtPostProcess {
    let sceneRt: Texture2D | null = null;
    let present: SpriteRenderer | null = null;
    let presentSlot = -1;
    let rtW = 0;
    let rtH = 0;
    let on = enabled;
    let presentRegistered = false;

    const crtShader = createSprite2DCustomShader({ fragment: CRT_FRAGMENT });

    const destroyChain = (): void => {
        if (present) {
            disposeSpriteRenderer(present); // unregisters + frees layer GPU
            present = null;
            presentRegistered = false;
            presentSlot = -1;
        }
        if (sceneRt) {
            // disposeSpriteRenderer leaves the externally-owned atlas texture alone,
            // so release the offscreen colour buffer ourselves.
            sceneRt.texture.destroy();
            sceneRt = null;
        }
    };

    const build = (cw: number, ch: number): void => {
        destroyChain();
        rtW = cw;
        rtH = ch;
        sceneRt = createRenderTexture2D(engine, cw, ch);
        const atlas = createGridSpriteAtlas(sceneRt, { cellWidthPx: cw, cellHeightPx: ch });
        const layer = createSprite2DLayer(atlas, { capacity: 1, order: 0, pivot: [0, 0], customShader: crtShader });
        presentSlot = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [cw, ch], frame: 0, visible: true });
        present = createSpriteRenderer(engine, { layers: [layer] }); // default clear = opaque black
        // Registered after the scene renderer (which is already registered), so the
        // present pass runs second and samples the finished scene texture.
        registerSpriteRenderer(present);
        presentRegistered = true;
        setSpriteRendererTarget(scene, sceneRt);
    };

    const setEnabled = (next: boolean): void => {
        if (next === on) {
            return;
        }
        on = next;
        if (!on) {
            // Restore the direct-to-swapchain path and stop running the present pass.
            setSpriteRendererTarget(scene, null);
            if (present && presentRegistered) {
                unregisterSpriteRenderer(present);
                presentRegistered = false;
            }
        }
        // Re-enabling rebuilds lazily on the next sync() (canvas size is known there).
    };

    return {
        get enabled(): boolean {
            return on;
        },
        setEnabled,
        toggle(): boolean {
            setEnabled(!on);
            return on;
        },
        sync(cw: number, ch: number): void {
            if (!on || cw < 1 || ch < 1) {
                return;
            }
            if (!present || cw !== rtW || ch !== rtH) {
                build(cw, ch);
            } else if (!presentRegistered) {
                registerSpriteRenderer(present);
                presentRegistered = true;
                setSpriteRendererTarget(scene, sceneRt!);
            }
            updateSprite2DIndex(present!.layers[0]!, presentSlot, { positionPx: [0, 0], sizePx: [cw, ch], visible: true });
            // params: strength, aspect, scanline cycles (~6 device-px pitch), device width.
            setSprite2DShaderParams(present!.layers[0]!, [1, cw / ch, ch / 6, cw]);
        },
    };
}
