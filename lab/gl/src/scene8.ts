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

/**
 * Scene 8 — Render-to-Texture Round-Trip.
 *
 * Exercises the @babylonjs/lite-gl/render-target sub-entry end-to-end:
 *   - PASS 1 renders a procedural pattern INTO an offscreen 512×512 render
 *     target (`createRenderTarget` → `bindRenderTarget(engine, rt)` binds the
 *     FBO and sets the viewport to the RT size automatically).
 *   - PASS 2 binds the default framebuffer (`bindRenderTarget(engine, null)` —
 *     restores the canvas viewport) and samples the RT's color texture
 *     fullscreen with a radial vignette (`setEffectTexture(…, rt.texture)`).
 *
 * The pattern is deliberately RADIALLY SYMMETRIC about the RT centre (it depends
 * only on `length(vUv - 0.5)`), so the round-trip is invariant to any texture
 * Y-orientation convention — that keeps the lite render pixel-comparable to the
 * Babylon.js `createRenderTargetTexture` + `EffectRenderer` reference
 * (lab/gl/src/babylon-ref-scene8.ts) regardless of FBO sampling origin.
 *
 * Determinism: `?seekTime=<seconds>` pins the animation to a fixed time, renders
 * exactly one round-trip, stamps `dataset.animationFrozen` and halts.
 */

const RT_SIZE = 512;

/** Parse the parity harness's `?seekTime=<seconds>` query param (null when absent). */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

// PASS 1 — procedural radial pattern written into the render target. Depends
// ONLY on r = length(vUv - 0.5): concentric animated rings tinted by a radial
// cosine palette. Radial symmetry makes the RT content orientation-agnostic.
const PATTERN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
void main() {
    float r = length(vUv - 0.5);
    float rings = 0.5 + 0.5 * cos(r * 42.0 - uTime * 1.5);
    vec3 palette = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4);
    glFragColor = vec4(palette * rings, 1.0);
}`;

// PASS 2 — sample the RT fullscreen and apply a radial screen-space vignette
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
    col *= 1.0 - 0.6 * r * r;
    glFragColor = vec4(col, 1.0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });

// Offscreen color target. RGBA8, LINEAR/CLAMP (the createRenderTarget
// defaults), no depth — this is a pure 2D round-trip.
const rt = createRenderTarget(engine, { width: RT_SIZE, height: RT_SIZE });

const patternWrapper = createEffectWrapper(engine, {
    name: "gl-scene8-rtt-pattern",
    fragmentSource: PATTERN_FRAGMENT,
    uniformNames: ["uTime"],
});
const compositeWrapper = createEffectWrapper(engine, {
    name: "gl-scene8-rtt-composite",
    fragmentSource: COMPOSITE_FRAGMENT,
    uniformNames: ["uResolution"],
    samplerNames: ["uRt"],
});

executeWhenCompiled(engine, compositeWrapper.effect, () => {
    console.log("scene8: render-to-texture round-trip effects compiled");
});

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, patternWrapper.effect) || !isEffectReady(engine, compositeWrapper.effect)) {
        return;
    }
    resizeGLEngine(engine);
    const uTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

    // ── PASS 1: render the radial pattern into the render target ──
    bindRenderTarget(engine, rt); // binds the FBO + sets viewport to RT_SIZE
    applyEffectWrapper(patternWrapper);
    setEffectFloat(engine, patternWrapper.effect, "uTime", uTime);
    drawEffect(engine);

    // ── PASS 2: composite the RT to the screen ──
    bindRenderTarget(engine, null); // default framebuffer + canvas viewport
    applyEffectWrapper(compositeWrapper);
    setEffectFloat2(engine, compositeWrapper.effect, "uResolution", canvas.width, canvas.height);
    setEffectTexture(engine, compositeWrapper.effect, "uRt", rt.texture);
    drawEffect(engine);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "2"; // one RT pass + one screen pass
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
