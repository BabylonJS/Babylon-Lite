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
import { bindRenderTarget, createFloatRenderTarget } from "babylon-lite-gl/render-target";

/**
 * Scene 14 — Float (HDR) Render Target.
 *
 * The HDR opt-in counterpart of scene8's RGBA8 round-trip. Exercises
 * @babylonjs/lite-gl/render-target's `createFloatRenderTarget` end-to-end:
 *   - PASS 1 renders a high-dynamic-range pattern whose values EXCEED 1.0 (a
 *     bright central bloom up to ~2.7 falling off radially) INTO an offscreen
 *     512×512 HALF_FLOAT (RGBA16F) render target. `createFloatRenderTarget`
 *     carries the float sized-format table that `createRenderTarget` omits, and
 *     defaults to `gl.HALF_FLOAT`; the engine downgrades it to the best
 *     renderable type its caps support (`textureHalfFloatRender`).
 *   - PASS 2 binds the default framebuffer (`bindRenderTarget(engine, null)`),
 *     samples the float RT fullscreen, applies a FIXED exposure tone-map
 *     (`1 - exp(-c·exposure)`, which maps the >1.0 HDR values back into [0,1)),
 *     then the scene8 aspect-corrected radial vignette → LDR screen.
 *
 * Both the HDR pattern and the vignette depend ONLY on `length(vUv - 0.5)`, so
 * the round-trip is invariant to any texture Y-orientation convention — that
 * keeps the lite render pixel-comparable to the Babylon.js
 * `createRenderTargetTexture` (HALF_FLOAT) + `EffectRenderer` reference
 * (lab/gl/src/babylon-ref-scene14.ts) regardless of FBO sampling origin.
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

// PASS 1 — procedural HDR pattern written into the half-float render target.
// Depends ONLY on r = length(vUv - 0.5): a bright central bloom (peak ~7×, decays
// with r²) modulated by animated rings and tinted by a radial cosine palette. The
// resulting colours exceed 1.0 across the centre, so they are only representable
// in a float/half-float target (an RGBA8 target would clamp them). Radial symmetry
// makes the RT content orientation-agnostic.
const PATTERN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
void main() {
    float r = length(vUv - 0.5);
    float bloom = 7.0 * exp(-r * r * 7.0);
    float rings = 0.6 + 0.4 * cos(r * 38.0 - uTime * 1.5);
    vec3 palette = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4);
    vec3 hdr = palette * (bloom * rings + 0.25);
    glFragColor = vec4(hdr, 1.0);
}`;

// PASS 2 — sample the HDR float RT fullscreen, tone-map it to LDR with a FIXED
// exposure (`1 - exp(-c·exposure)` compresses the >1.0 values into [0,1)), then
// apply scene8's aspect-corrected radial vignette (kept circular; symmetric under
// any axis flip, so it too is orientation-agnostic).
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform vec2 uResolution;
uniform sampler2D uRt;
void main() {
    vec3 hdr = texture(uRt, vUv).rgb;
    float exposure = 1.25;
    vec3 col = vec3(1.0) - exp(-hdr * exposure);
    vec2 q = vUv - 0.5;
    q.x *= uResolution.x / max(uResolution.y, 1.0);
    float r = length(q);
    col *= 1.0 - 0.6 * r * r;
    glFragColor = vec4(col, 1.0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });

// Offscreen HDR color target. Half-float (RGBA16F) by default, LINEAR/CLAMP (the
// createFloatRenderTarget defaults), no depth — a pure 2D HDR round-trip. The
// requested HALF_FLOAT type is downgraded by the engine if its caps require it.
const rt = createFloatRenderTarget(engine, { width: RT_SIZE, height: RT_SIZE });

const patternWrapper = createEffectWrapper(engine, {
    name: "gl-scene14-hdr-pattern",
    fragmentSource: PATTERN_FRAGMENT,
    uniformNames: ["uTime"],
});
const compositeWrapper = createEffectWrapper(engine, {
    name: "gl-scene14-hdr-tonemap",
    fragmentSource: COMPOSITE_FRAGMENT,
    uniformNames: ["uResolution"],
    samplerNames: ["uRt"],
});

executeWhenCompiled(engine, compositeWrapper.effect, () => {
    console.log("scene14: float (HDR) render-target tone-map effects compiled");
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

    // ── PASS 1: render the HDR pattern into the half-float render target ──
    bindRenderTarget(engine, rt); // binds the FBO + sets viewport to RT_SIZE
    applyEffectWrapper(patternWrapper);
    setEffectFloat(engine, patternWrapper.effect, "uTime", uTime);
    drawEffect(engine);

    // ── PASS 2: tone-map the float RT to the LDR screen ──
    bindRenderTarget(engine, null); // default framebuffer + canvas viewport
    applyEffectWrapper(compositeWrapper);
    setEffectFloat2(engine, compositeWrapper.effect, "uResolution", canvas.width, canvas.height);
    setEffectTexture(engine, compositeWrapper.effect, "uRt", rt.texture);
    drawEffect(engine);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "2"; // one HDR pass + one tone-map pass
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
