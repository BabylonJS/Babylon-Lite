import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { ThinTexture } from "@babylonjs/core/Materials/Textures/thinTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
// Side-effect import: createRenderTargetTexture is patched onto ThinEngine.prototype
// by the renderTarget extension (bindFramebuffer / unBindFramebuffer are core).
import "@babylonjs/core/Engines/Extensions/engine.renderTarget.js";

/**
 * Babylon.js reference for GL Scene 9 — Ping-Pong Feedback.
 *
 * Reproduces lab/gl/src/scene9.ts (which uses @babylonjs/lite-gl/render-target's
 * createPingPong + swap) with Babylon's ThinEngine + TWO
 * `createRenderTargetTexture` targets ping-ponged BY HAND + `EffectRenderer`, so
 * the parity harness can diff the two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - Geometry / UV / context / size: identical to the other GL references
 *    (default EffectRenderer fullscreen quad, postprocess vUV, opaque buffer,
 *    hwScaling=1).
 *  - SEED renders the SAME radial pattern into the first 512×512 RGBA8 target,
 *    then the boolean `readIsA` flips — the analogue of lite-gl's first
 *    `bindRenderTarget(engine, pp.write)` + draw + `pp.swap()`.
 *  - FEEDBACK runs the SAME N=6 iterations: `renderer.render(feedbackWrapper, writeRT)`
 *    binds the write target while the wrapper's onApplyObservable points `uPrev`
 *    at the READ target's ThinTexture and `uK` at k, then the boolean flips —
 *    lite-gl's `bindRenderTarget(pp.write)` / `setEffectTexture(pp.read.texture)`
 *    / draw / `pp.swap()`.
 *  - COMPOSITE samples the final feedback target fullscreen with the SAME
 *    aspect-corrected vignette.
 *  - Every term depends ONLY on `length(vUV - 0.5)` and each feedback pass samples
 *    the previous target at the SAME vUV, so the chain is invariant to any FBO
 *    sampling-origin / Y-flip difference between the two engines — the feedback is
 *    orientation-agnostic by construction.
 *  - Fragments are the SAME expressions as scene9 in ES1.00 form (varying /
 *    gl_FragColor / texture2D); Babylon's WebGL2 processor converts to ES3.00.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE seed + 6 feedback + 1
 * composite frame at uTime=seekTime then stamps dataset.animationFrozen="true"
 * and stops the loop.
 */

const RT_SIZE = 512;
const FEEDBACK_ITERATIONS = 6;

const SEED_SHADER = `
precision highp float;
varying vec2 vUV;
uniform float uTime;
void main(void) {
    float r = length(vUV - 0.5);
    vec3 palette = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4);
    float rings = 0.5 + 0.5 * cos(r * 40.0 - uTime * 1.5);
    gl_FragColor = vec4(palette * rings, 1.0);
}`;

const FEEDBACK_SHADER = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uPrev;
uniform float uTime;
uniform float uK;
void main(void) {
    float r = length(vUV - 0.5);
    vec3 prev = texture2D(uPrev, vUV).rgb;
    vec3 cur = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4 + uK * 0.35);
    gl_FragColor = vec4(mix(prev, cur, 0.5), 1.0);
}`;

const COMPOSITE_SHADER = `
precision highp float;
varying vec2 vUV;
uniform vec2 uResolution;
uniform sampler2D uTex;
void main(void) {
    vec3 col = texture2D(uTex, vUV).rgb;
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

    // Two offscreen color targets — RGBA8, BILINEAR/CLAMP, no depth: matches
    // lite-gl's createPingPong defaults (gl.LINEAR / gl.CLAMP_TO_EDGE, RGBA8).
    const rtOptions = {
        generateDepthBuffer: false,
        generateStencilBuffer: false,
        generateMipMaps: false,
        samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
        format: Constants.TEXTUREFORMAT_RGBA,
    };
    const rtA = engine.createRenderTargetTexture(RT_SIZE, rtOptions);
    const rtB = engine.createRenderTargetTexture(RT_SIZE, rtOptions);
    // Wrap each RT's color attachment so the feedback / composite effects can
    // sample whichever one is currently "read".
    const texA = new ThinTexture(rtA.texture);
    texA.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    texA.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    const texB = new ThinTexture(rtB.texture);
    texB.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    texB.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

    const renderer = new EffectRenderer(engine);
    const seedWrapper = new EffectWrapper({
        engine,
        name: "gl-scene9-pingpong-seed-ref",
        fragmentShader: SEED_SHADER,
        uniforms: ["uTime"],
        samplers: [],
        useShaderStore: false,
    });
    const feedbackWrapper = new EffectWrapper({
        engine,
        name: "gl-scene9-pingpong-feedback-ref",
        fragmentShader: FEEDBACK_SHADER,
        uniforms: ["uTime", "uK"],
        samplers: ["uPrev"],
        useShaderStore: false,
    });
    const compositeWrapper = new EffectWrapper({
        engine,
        name: "gl-scene9-pingpong-composite-ref",
        fragmentShader: COMPOSITE_SHADER,
        uniforms: ["uResolution"],
        samplers: ["uTex"],
        useShaderStore: false,
    });

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let currentTime = 0;
    let currentK = 0;
    // The ThinTexture the feedback / composite passes should sample this draw
    // (the previous frame's output) — updated before every renderer.render call.
    let readTexture: ThinTexture = texA;

    seedWrapper.onApplyObservable.add(() => {
        seedWrapper.effect.setFloat("uTime", currentTime);
    });
    feedbackWrapper.onApplyObservable.add(() => {
        feedbackWrapper.effect.setFloat("uTime", currentTime);
        feedbackWrapper.effect.setFloat("uK", currentK);
        feedbackWrapper.effect.setTexture("uPrev", readTexture);
    });
    compositeWrapper.onApplyObservable.add(() => {
        compositeWrapper.effect.setFloat2("uResolution", canvas.width, canvas.height);
        compositeWrapper.effect.setTexture("uTex", readTexture);
    });

    let firstFrameDrawn = false;
    engine.runRenderLoop(() => {
        // Every pass must be link-complete before the feedback chain is valid.
        if (!seedWrapper.effect.isReady() || !feedbackWrapper.effect.isReady() || !compositeWrapper.effect.isReady()) {
            return;
        }
        engine.resize();
        currentTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

        // Manual ping-pong: `readIsA` picks which RT is "read" (sampled) vs
        // "write" (rendered into); it flips after every pass (== pp.swap()).
        // readIsA → read = rtA/texA, write = rtB; !readIsA → read = rtB/texB, write = rtA.
        let readIsA = true;

        // ── SEED: write P0 into the write RT, then swap so it becomes `read`. ──
        renderer.render(seedWrapper, readIsA ? rtB : rtA);
        readIsA = !readIsA;

        // ── FEEDBACK: N fixed iterations sampling the read RT into the write RT. ──
        for (let k = 1; k <= FEEDBACK_ITERATIONS; k++) {
            readTexture = readIsA ? texA : texB;
            currentK = k;
            renderer.render(feedbackWrapper, readIsA ? rtB : rtA);
            readIsA = !readIsA;
        }

        // ── COMPOSITE: sample the final feedback RT to the screen + vignette. ──
        readTexture = readIsA ? texA : texB;
        renderer.render(compositeWrapper);

        if (!firstFrameDrawn) {
            firstFrameDrawn = true;
            canvas.dataset.drawCalls = String(1 + FEEDBACK_ITERATIONS + 1);
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
