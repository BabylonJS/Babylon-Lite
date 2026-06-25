import {
    applyEffectWrapper,
    createEffectWrapper,
    createGLEngine,
    drawEffect,
    executeWhenCompiled,
    isEffectReady,
    resizeGLEngine,
    runRenderLoop,
    setEffectFloat,
    setEffectFloat2,
    setEffectTexture,
    stopRenderLoop,
} from "babylon-lite-gl";
import { bindRenderTarget, createRenderTarget } from "babylon-lite-gl/render-target";
import { clearEngine, generateRenderTargetStencil, setColorMask, setStencilState } from "babylon-lite-gl/depth-stencil";

/**
 * Scene 11 — Stencil Masking.
 *
 * Exercises the converged stencil API end-to-end:
 *   - `createRenderTarget` makes an offscreen 512×512 RGBA8 + depth target, then
 *     `generateRenderTargetStencil(engine, rt)` (from
 *     @babylonjs/lite-gl/depth-stencil) replaces the depth-only renderbuffer with
 *     a packed DEPTH24_STENCIL8 attachment so the FBO carries a stencil plane.
 *   - PASS 1 (mask write): with stencil `func = ALWAYS`, `ref = 1`, op
 *     `KEEP/KEEP/REPLACE` and COLOR WRITES MASKED OFF (`setColorMask(false…)`),
 *     a centred filled disc is drawn — the fragment `discard`s everywhere
 *     `length(vUv-0.5) >= R`, so the stencil plane ends up `1` only inside the
 *     disc and `0` outside, with the colour buffer untouched (still the clear).
 *   - PASS 2 (masked draw): with stencil `func = EQUAL`, `ref = 1`, op
 *     `KEEP/KEEP/KEEP` (no stencil writes) and colour writes back on, a fullscreen
 *     animated radial gradient is drawn — the stencil test admits it ONLY where
 *     the plane equals 1 (inside the disc). Outside stays the clear colour.
 *   - COMPOSITE binds the default framebuffer (`bindRenderTarget(engine, null)`),
 *     disables the stencil test and samples the RT fullscreen with an
 *     aspect-corrected radial vignette.
 *
 * Every shape depends ONLY on `r = length(vUv - 0.5)` (a radially symmetric disc
 * + radial gradient) and the composite samples at the same UV, so the whole
 * round-trip is invariant to any texture Y-origin convention — that keeps the
 * lite render pixel-comparable to the Babylon.js `createRenderTargetTexture`
 * (with a stencil buffer) + `EffectRenderer` reference
 * (lab/gl/src/babylon-ref-scene11.ts) regardless of FBO sampling origin.
 *
 * Determinism: `?seekTime=<seconds>` pins the animation to a fixed time, renders
 * exactly one round-trip, stamps `dataset.animationFrozen` and halts.
 */

const RT_SIZE = 512;

/** Disc radius (in UV space, centred at 0.5). Identical literal in the BJS
 *  reference so the stencil mask boundary is byte-identical between engines. */
const DISC_RADIUS = 0.4;

/** RGBA clear colour of the render target — visible wherever the stencil mask
 *  rejects the gradient (outside the disc). */
const CLEAR_R = 0.06;
const CLEAR_G = 0.07;
const CLEAR_B = 0.11;

/** Parse the parity harness's `?seekTime=<seconds>` query param (null when absent). */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

// PASS 1 — the mask shape. Discards outside the disc so the stencil REPLACE only
// stamps `1` inside `length(vUv-0.5) < DISC_RADIUS`. Colour writes are masked off
// during this pass, so the emitted colour is irrelevant.
const DISC_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
void main() {
    float r = length(vUv - 0.5);
    if (r > ${DISC_RADIUS}) {
        discard;
    }
    glFragColor = vec4(1.0, 1.0, 1.0, 1.0);
}`;

// PASS 2 — fullscreen animated radial gradient. Depends ONLY on r = length(vUv-0.5):
// concentric animated rings tinted by a radial cosine palette. The stencil test
// (EQUAL 1) clips it to the disc.
const GRADIENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
void main() {
    float r = length(vUv - 0.5);
    float rings = 0.5 + 0.5 * cos(r * 34.0 - uTime * 1.5);
    vec3 palette = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4);
    glFragColor = vec4(palette * rings, 1.0);
}`;

// COMPOSITE — sample the RT fullscreen and apply a radial screen-space vignette
// (aspect-corrected so it stays circular; still symmetric under any axis flip,
// so it too is orientation-agnostic).
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform vec2 uResolution;
uniform sampler2D uRt;
void main() {
    vec3 col = texture(uRt, vUv).rgb;
    vec2 q = vUv - 0.5;
    q.x *= uResolution.x / max(uResolution.y, 1.0);
    float r = length(q);
    col *= 1.0 - 0.5 * r * r;
    glFragColor = vec4(col, 1.0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });
const gl = engine.gl;

// Offscreen color target with a depth buffer, then upgrade its depth-only
// renderbuffer to a packed DEPTH24_STENCIL8 attachment so the FBO carries a
// stencil plane for the masking passes.
const rt = createRenderTarget(engine, { width: RT_SIZE, height: RT_SIZE, generateDepthBuffer: true });
generateRenderTargetStencil(engine, rt);

const discWrapper = createEffectWrapper(engine, {
    name: "gl-scene11-stencil-disc",
    fragmentSource: DISC_FRAGMENT,
});
const gradientWrapper = createEffectWrapper(engine, {
    name: "gl-scene11-stencil-gradient",
    fragmentSource: GRADIENT_FRAGMENT,
    uniformNames: ["uTime"],
});
const compositeWrapper = createEffectWrapper(engine, {
    name: "gl-scene11-stencil-composite",
    fragmentSource: COMPOSITE_FRAGMENT,
    uniformNames: ["uResolution"],
    samplerNames: ["uRt"],
});

executeWhenCompiled(engine, compositeWrapper.effect, () => {
    console.log("scene11: stencil-masking effects compiled");
});

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, discWrapper.effect) || !isEffectReady(engine, gradientWrapper.effect) || !isEffectReady(engine, compositeWrapper.effect)) {
        return;
    }
    resizeGLEngine(engine);
    const uTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

    // ── Bind the render target and clear colour + stencil to a known state ──
    bindRenderTarget(engine, rt); // binds the FBO + sets viewport to RT_SIZE
    setColorMask(engine, true, true, true, true);
    setStencilState(engine, { test: true, mask: 0xff });
    clearEngine(engine, { color: { r: CLEAR_R, g: CLEAR_G, b: CLEAR_B }, stencil: true });

    // ── PASS 1: stamp stencil = 1 inside the disc (no colour writes) ──
    setColorMask(engine, false, false, false, false);
    setStencilState(engine, {
        test: true,
        mask: 0xff,
        func: gl.ALWAYS,
        ref: 1,
        funcMask: 0xff,
        opFail: gl.KEEP,
        opZFail: gl.KEEP,
        opZPass: gl.REPLACE,
    });
    applyEffectWrapper(discWrapper);
    drawEffect(engine);

    // ── PASS 2: draw the gradient only where stencil == 1 (inside the disc) ──
    setColorMask(engine, true, true, true, true);
    setStencilState(engine, {
        test: true,
        mask: 0x00,
        func: gl.EQUAL,
        ref: 1,
        funcMask: 0xff,
        opFail: gl.KEEP,
        opZFail: gl.KEEP,
        opZPass: gl.KEEP,
    });
    applyEffectWrapper(gradientWrapper);
    setEffectFloat(engine, gradientWrapper.effect, "uTime", uTime);
    drawEffect(engine);

    // ── COMPOSITE: sample the masked RT to the screen (stencil disabled) ──
    bindRenderTarget(engine, null); // default framebuffer + canvas viewport
    setStencilState(engine, { test: false });
    setColorMask(engine, true, true, true, true);
    applyEffectWrapper(compositeWrapper);
    setEffectFloat2(engine, compositeWrapper.effect, "uResolution", canvas.width, canvas.height);
    setEffectTexture(engine, compositeWrapper.effect, "uRt", rt.texture);
    drawEffect(engine);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "3"; // disc mask + masked gradient + screen composite
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
