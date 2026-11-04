import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { ThinTexture } from "@babylonjs/core/Materials/Textures/thinTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
// Side-effect import: createDynamicTexture / updateDynamicTexture are patched onto
// ThinEngine.prototype by the dynamicTexture engine extension.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";

/**
 * Babylon.js reference for GL Scene 13 — Dynamic Texture.
 *
 * Reproduces lab/gl/src/scene13.ts (which uses @babylonjs/lite-gl's
 * createDynamicTexture + updateDynamicTexture) with Babylon's DIRECT analogue —
 * the `ThinEngine.createDynamicTexture` + `updateDynamicTexture` engine extension
 * — so the parity harness can diff the two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - Geometry / UV / context / size: identical to the other GL references
 *    (default EffectRenderer fullscreen quad, postprocess vUV, opaque buffer,
 *    hwScaling=1).
 *  - Surface: the SAME 256×256 2D canvas, drawn by a byte-identical drawSurface()
 *    (filled rects, arc discs and a linear gradient — NO text). Both pages run in
 *    the same browser, so the Canvas2D rasterisation is identical.
 *  - Allocation: `engine.createDynamicTexture(SIZE, SIZE, false, BILINEAR)` is the
 *    exact analogue of lite's `createDynamicTexture` defaults (RGBA8, LINEAR/LINEAR,
 *    no mipmaps). The InternalTexture is wrapped in a `ThinTexture` so the effect
 *    can sample it, and forced to CLAMP/CLAMP to match lite (lite defaults to
 *    CLAMP_TO_EDGE; Babylon's ThinTexture defaults to WRAP, which would differ at
 *    the very edge texels under LINEAR filtering).
 *  - Orientation: lite-gl uploads the canvas with invertY=FALSE (canvas top row →
 *    texture t=0) and the scene13 fragment flips V (`1.0 - vUv.y`) to display it
 *    upright. This reference uploads with invertY=TRUE (canvas top row → texture
 *    t=1) and samples the texture DIRECTLY (no in-shader flip). invertY=true +
 *    direct sampling is the exact mirror of invertY=false + flipped sampling: both
 *    map screen-top to canvas-top, producing the SAME upright image.
 *
 * Determinism: ?seekTime=<seconds> repaints the surface at t=seekTime, re-uploads
 * the texture, renders exactly ONE frame, then stamps dataset.animationFrozen and
 * stops the loop.
 */

const TAU = Math.PI * 2;
const SURFACE_SIZE = 256;

// ES1.00 form of scene13's fragment, WITHOUT the in-shader V-flip (see header).
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
void main(void) {
    // This reference uploads the canvas with invertY=true, so the canvas top row
    // is at t=1 — sample directly to display it upright (the exact mirror of
    // lite-gl's invertY=false upload + (1.0 - vUv.y) flip).
    vec3 c = texture2D(uTex, vUV).rgb;
    gl_FragColor = vec4(c, 1.0);
}`;

/** Parse the parity harness's `?seekTime=<seconds>` query param (null when absent). */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

(function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = new ThinEngine(canvas, false, { alpha: false, premultipliedAlpha: false, stencil: false }, false);

    // Offscreen 2D canvas that backs the dynamic texture (same as scene13).
    const surface = document.createElement("canvas");
    surface.width = SURFACE_SIZE;
    surface.height = SURFACE_SIZE;
    const ctx = surface.getContext("2d");
    if (ctx === null) {
        throw new Error("babylon-ref-scene13: 2D context unavailable for the dynamic texture");
    }

    /** Repaint the offscreen 2D canvas for time `t` (seconds). Deterministic, text-free. */
    function drawSurface(t: number): void {
        if (ctx === null) {
            return;
        }
        // Vertical gradient background — distinct top vs bottom colours make any
        // V-flip mismatch immediately obvious (and reveal it as a parity failure).
        const bg = ctx.createLinearGradient(0, 0, 0, SURFACE_SIZE);
        bg.addColorStop(0, "#0b2545");
        bg.addColorStop(1, "#3a0d2e");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, SURFACE_SIZE, SURFACE_SIZE);

        // Static palette bar across the TOP — fixed `fillRect`s, vertically asymmetric.
        const swatches = ["#ff5d5d", "#ffb14e", "#ffe14e", "#5dff8f", "#4ec3ff", "#9b6dff"];
        const sw = SURFACE_SIZE / swatches.length;
        for (let i = 0; i < swatches.length; i++) {
            ctx.fillStyle = swatches[i]!;
            ctx.fillRect(i * sw, 16, sw, 28);
        }

        // Fixed framed panel (nested `fillRect`s) anchoring the lower-left corner.
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.fillRect(24, 150, 92, 72);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(32, 158, 76, 56);

        // Orbiting colour discs — animated by `t` (identical on lite + reference at
        // the frozen seek time).
        for (let i = 0; i < 6; i++) {
            const x = 128 + 78 * Math.cos(t * 0.7 + i * 1.05);
            const y = 150 + 60 * Math.sin(t * 0.9 + i * 1.05);
            ctx.beginPath();
            ctx.arc(x, y, 18, 0, TAU);
            ctx.fillStyle = "hsl(" + ((((i * 60 + t * 40) % 360) + 360) % 360) + ", 80%, 60%)";
            ctx.fill();
        }

        // Big white disc near the TOP-centre (slow bob) — a second upright cue.
        ctx.beginPath();
        ctx.arc(128, 86 + 6 * Math.sin(t * 1.5), 26, 0, TAU);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
    }

    const startMs = performance.now();
    drawSurface(0);

    // Allocate the dynamic texture: RGBA8, BILINEAR (LINEAR/LINEAR, no mipmaps) to
    // match lite-gl's createDynamicTexture defaults.
    const internal = engine.createDynamicTexture(SURFACE_SIZE, SURFACE_SIZE, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
    // Wrap so the effect can sample it; force CLAMP to match lite (CLAMP_TO_EDGE).
    const tex = new ThinTexture(internal);
    tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

    const renderer = new EffectRenderer(engine);
    const wrapper = new EffectWrapper({
        engine,
        name: "gl-scene13-dynamic-texture-ref",
        fragmentShader: FRAGMENT_SHADER,
        samplers: ["uTex"],
        useShaderStore: false,
    });

    wrapper.onApplyObservable.add(() => {
        wrapper.effect.setTexture("uTex", tex);
    });

    const seekTime = parseSeekTime();
    let firstFrameDrawn = false;
    wrapper.effect.executeWhenCompiled(() => {
        engine.runRenderLoop(() => {
            engine.resize();
            const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
            drawSurface(t);
            // Re-upload the canvas. invertY=true puts the canvas top row at texture
            // t=1 — the mirror of lite's invertY=false upload + shader flip.
            engine.updateDynamicTexture(internal, surface, true);
            renderer.render(wrapper);
            if (!firstFrameDrawn) {
                firstFrameDrawn = true;
                canvas.dataset.drawCalls = "1";
                canvas.dataset.initMs = String(performance.now() - initStart);
                canvas.dataset.ready = "true";
                if (seekTime !== null) {
                    canvas.dataset.animationFrozen = "true";
                    engine.stopRenderLoop();
                }
            }
        });
    });

    window.addEventListener("resize", () => engine.resize());
})();
