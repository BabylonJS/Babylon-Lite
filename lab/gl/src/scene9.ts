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
import { bindRenderTarget, createPingPong } from "babylon-lite-gl/render-target";

/**
 * Scene 9 — Ping-Pong Feedback.
 *
 * Exercises the @babylonjs/lite-gl/render-target sub-entry's CONVERGED feedback
 * API — `createPingPong` + `swap` — which scene8 (single-RTT round-trip) does not
 * cover:
 *   - SEED: render a procedural radial pattern P0 into the ping-pong's `write`
 *     target, then `swap()` so it becomes `read`.
 *   - FEEDBACK: run N=6 FIXED iterations. Each binds the `write` target, samples
 *     the previous frame from `read.texture` (`setEffectTexture`), blends it 50/50
 *     with a k-shifted radial palette, then `swap()`s — the classic
 *     sample-previous / render-next / exchange ping-pong loop (the same pattern
 *     `bindRenderTarget(engine, pp.write)` → draw → `pp.swap()` the
 *     saturday-weirdness demo uses, here pinned to a deterministic iteration
 *     count).
 *   - COMPOSITE: bind the default framebuffer (`bindRenderTarget(engine, null)`)
 *     and sample the final feedback result fullscreen with a radial vignette.
 *
 * Like scene8, EVERY shader term depends ONLY on `r = length(vUv - 0.5)` and each
 * feedback pass samples `read` at the SAME `vUv` (no directional/spatial offset).
 * The seed is therefore radially symmetric about the target centre, and sampling
 * a radially-symmetric texture at the same uv keeps every iteration radially
 * symmetric too — so the whole feedback chain is invariant to any FBO
 * sampling-origin / Y-flip difference between lite-gl and Babylon.js. That keeps
 * the lite render pixel-comparable to the Babylon.js ThinEngine +
 * `createRenderTargetTexture` × 2 manual ping-pong reference
 * (lab/gl/src/babylon-ref-scene9.ts) regardless of orientation convention.
 *
 * Determinism: `?seekTime=<seconds>` pins the animation to a fixed time, renders
 * exactly one seed + 6 feedback + 1 composite frame, stamps
 * `dataset.animationFrozen` and halts.
 */

const RT_SIZE = 512;
const FEEDBACK_ITERATIONS = 6;

/** Parse the parity harness's `?seekTime=<seconds>` query param (null when absent). */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

// SEED — procedural radial pattern P0 written into the first write target.
// Depends ONLY on r = length(vUv - 0.5): animated concentric rings tinted by a
// radial cosine palette. Radial symmetry makes it orientation-agnostic.
const SEED_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
void main() {
    float r = length(vUv - 0.5);
    vec3 palette = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4);
    float rings = 0.5 + 0.5 * cos(r * 40.0 - uTime * 1.5);
    glFragColor = vec4(palette * rings, 1.0);
}`;

// FEEDBACK — sample the previous frame at the SAME uv and blend it 50/50 with a
// per-iteration (uK) phase-shifted radial palette. Same-uv sampling of a
// radially-symmetric input keeps the result orientation-agnostic every pass.
const FEEDBACK_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform sampler2D uPrev;
uniform float uTime;
uniform float uK;
void main() {
    float r = length(vUv - 0.5);
    vec3 prev = texture(uPrev, vUv).rgb;
    vec3 cur = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4 + uK * 0.35);
    glFragColor = vec4(mix(prev, cur, 0.5), 1.0);
}`;

// COMPOSITE — sample the final feedback target fullscreen and apply a radial
// screen-space vignette (aspect-corrected so it stays circular; symmetric under
// any axis flip, so it too is orientation-agnostic).
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform vec2 uResolution;
uniform sampler2D uTex;
void main() {
    vec3 col = texture(uTex, vUv).rgb;
    vec2 q = vUv - 0.5;
    q.x *= uResolution.x / max(uResolution.y, 1.0);
    float r = length(q);
    col *= 1.0 - 0.6 * r * r;
    glFragColor = vec4(col, 1.0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });

// Two same-sized offscreen targets exchanged each pass. RGBA8, LINEAR/CLAMP (the
// createPingPong defaults), no depth — a pure 2D frame-feedback chain.
const pingpong = createPingPong(engine, { width: RT_SIZE, height: RT_SIZE });

const seedWrapper = createEffectWrapper(engine, {
    name: "gl-scene9-pingpong-seed",
    fragmentSource: SEED_FRAGMENT,
    uniformNames: ["uTime"],
});
const feedbackWrapper = createEffectWrapper(engine, {
    name: "gl-scene9-pingpong-feedback",
    fragmentSource: FEEDBACK_FRAGMENT,
    uniformNames: ["uTime", "uK"],
    samplerNames: ["uPrev"],
});
const compositeWrapper = createEffectWrapper(engine, {
    name: "gl-scene9-pingpong-composite",
    fragmentSource: COMPOSITE_FRAGMENT,
    uniformNames: ["uResolution"],
    samplerNames: ["uTex"],
});

executeWhenCompiled(engine, compositeWrapper.effect, () => {
    console.log("scene9: ping-pong feedback effects compiled");
});

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, seedWrapper.effect) || !isEffectReady(engine, feedbackWrapper.effect) || !isEffectReady(engine, compositeWrapper.effect)) {
        return;
    }
    resizeGLEngine(engine);
    const uTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

    // ── SEED: write P0 into `write`, then swap so it becomes `read`. ──
    bindRenderTarget(engine, pingpong.write);
    applyEffectWrapper(seedWrapper);
    setEffectFloat(engine, seedWrapper.effect, "uTime", uTime);
    drawEffect(engine);
    pingpong.swap();

    // ── FEEDBACK: N fixed iterations, each sampling `read` (last pass) while
    //    rendering into `write`, then swapping — the ping-pong feedback loop. ──
    for (let k = 1; k <= FEEDBACK_ITERATIONS; k++) {
        bindRenderTarget(engine, pingpong.write);
        applyEffectWrapper(feedbackWrapper);
        setEffectFloat(engine, feedbackWrapper.effect, "uTime", uTime);
        setEffectFloat(engine, feedbackWrapper.effect, "uK", k);
        setEffectTexture(engine, feedbackWrapper.effect, "uPrev", pingpong.read.texture);
        drawEffect(engine);
        pingpong.swap();
    }

    // ── COMPOSITE: sample the final feedback result to the screen + vignette. ──
    bindRenderTarget(engine, null); // default framebuffer + canvas viewport
    applyEffectWrapper(compositeWrapper);
    setEffectFloat2(engine, compositeWrapper.effect, "uResolution", canvas.width, canvas.height);
    setEffectTexture(engine, compositeWrapper.effect, "uTex", pingpong.read.texture);
    drawEffect(engine);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = String(1 + FEEDBACK_ITERATIONS + 1); // 1 seed + 6 feedback + 1 composite
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
