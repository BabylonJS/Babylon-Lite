import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { ThinTexture } from "@babylonjs/core/Materials/Textures/thinTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
// Side-effect import: createRenderTargetTexture is patched onto ThinEngine.prototype
// by the renderTarget extension (bindFramebuffer / unBindFramebuffer are core).
import "@babylonjs/core/Engines/Extensions/engine.renderTarget.js";

/**
 * Babylon.js reference for GL Scene 8 — Render-to-Texture Round-Trip.
 *
 * Reproduces lab/gl/src/scene8.ts (which uses @babylonjs/lite-gl/render-target's
 * createRenderTarget + bindRenderTarget) with Babylon's ThinEngine +
 * `createRenderTargetTexture` + `EffectRenderer`, so the parity harness can diff
 * the two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - Geometry / UV / context / size: identical to the other GL references
 *    (default EffectRenderer fullscreen quad, postprocess vUV, opaque buffer,
 *    hwScaling=1).
 *  - PASS 1 renders the SAME radial pattern into a 512×512 RGBA8 render target.
 *    `renderer.render(patternWrapper, rtw)` binds the RT framebuffer, sets the
 *    viewport to the RT size, draws the fullscreen quad, then unbinds — the
 *    analogue of lite-gl's `bindRenderTarget(engine, rt)` + `drawEffect`.
 *  - PASS 2 samples that RT fullscreen with the SAME aspect-corrected vignette.
 *  - The pattern depends ONLY on `length(vUV - 0.5)`, so it is invariant to any
 *    FBO sampling-origin / Y-flip difference between the two engines — the
 *    round-trip is orientation-agnostic by construction.
 *  - Fragments are the SAME expressions as scene8 in ES1.00 form (varying /
 *    gl_FragColor / texture2D); Babylon's WebGL2 processor converts to ES3.00.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE round-trip at
 * uTime=seekTime then stamps dataset.animationFrozen="true" and stops the loop.
 */

const RT_SIZE = 512;

const PATTERN_SHADER = `
precision highp float;
varying vec2 vUV;
uniform float uTime;
void main(void) {
    float r = length(vUV - 0.5);
    float rings = 0.5 + 0.5 * cos(r * 42.0 - uTime * 1.5);
    vec3 palette = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4);
    gl_FragColor = vec4(palette * rings, 1.0);
}`;

const COMPOSITE_SHADER = `
precision highp float;
varying vec2 vUV;
uniform vec2 uResolution;
uniform sampler2D uRt;
void main(void) {
    vec3 col = texture2D(uRt, vUV).rgb;
    vec2 q = vUV - 0.5;
    q.x *= uResolution.x / max(uResolution.y, 1.0);
    float r = length(q);
    col *= 1.0 - 0.6 * r * r;
    gl_FragColor = vec4(col, 1.0);
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

    // Offscreen color target — RGBA8, BILINEAR/CLAMP, no depth: matches lite-gl's
    // createRenderTarget defaults (gl.LINEAR / gl.CLAMP_TO_EDGE, RGBA8, no depth).
    const rtw = engine.createRenderTargetTexture(RT_SIZE, {
        generateDepthBuffer: false,
        generateStencilBuffer: false,
        generateMipMaps: false,
        samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
        format: Constants.TEXTUREFORMAT_RGBA,
    });
    // Wrap the RT's color attachment so the composite effect can sample it.
    const rtSampleTexture = new ThinTexture(rtw.texture);
    rtSampleTexture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    rtSampleTexture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

    const renderer = new EffectRenderer(engine);
    const patternWrapper = new EffectWrapper({
        engine,
        name: "gl-scene8-rtt-pattern-ref",
        fragmentShader: PATTERN_SHADER,
        uniforms: ["uTime"],
        samplers: [],
        useShaderStore: false,
    });
    const compositeWrapper = new EffectWrapper({
        engine,
        name: "gl-scene8-rtt-composite-ref",
        fragmentShader: COMPOSITE_SHADER,
        uniforms: ["uResolution"],
        samplers: ["uRt"],
        useShaderStore: false,
    });

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let currentTime = 0;

    patternWrapper.onApplyObservable.add(() => {
        patternWrapper.effect.setFloat("uTime", currentTime);
    });
    compositeWrapper.onApplyObservable.add(() => {
        compositeWrapper.effect.setFloat2("uResolution", canvas.width, canvas.height);
        compositeWrapper.effect.setTexture("uRt", rtSampleTexture);
    });

    let firstFrameDrawn = false;
    engine.runRenderLoop(() => {
        // Both passes must be link-complete before the round-trip is valid.
        if (!patternWrapper.effect.isReady() || !compositeWrapper.effect.isReady()) {
            return;
        }
        engine.resize();
        currentTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

        // ── PASS 1: render the radial pattern into the render target ──
        renderer.render(patternWrapper, rtw);
        // ── PASS 2: composite the RT to the screen ──
        renderer.render(compositeWrapper);

        if (!firstFrameDrawn) {
            firstFrameDrawn = true;
            canvas.dataset.drawCalls = "2";
            canvas.dataset.initMs = String(performance.now() - initStart);
            canvas.dataset.ready = "true";
            if (seekTime !== null) {
                canvas.dataset.animationFrozen = "true";
                engine.stopRenderLoop();
            }
        }
    });

    window.addEventListener("resize", () => engine.resize());
})();
