import {
    applyEffectWrapper,
    createEffectWrapper,
    createGLEngine,
    createRawTexture,
    drawEffect,
    executeWhenCompiled,
    isEffectReady,
    loadTexture2D,
    resizeGLEngine,
    runRenderLoop,
    setEffectFloat,
    setEffectFloat2,
    setEffectTexture,
    setViewport,
    stopRenderLoop,
} from "babylon-lite-gl";

/**
 * Scene 3 — Textured Quad.
 *
 * Demonstrates the lite-gl texture API and custom fragment samplers:
 *   - `createRawTexture` uploads a procedurally-generated checkerboard from a
 *     `Uint8Array` (NEAREST + REPEAT so the cells stay crisp when tiled).
 *   - `loadTexture2D` asynchronously decodes a procedurally-generated PNG
 *     (a `data:` URL produced by a 2D canvas — no external assets).
 *   - A custom `fragmentSource` samples BOTH textures via two declared
 *     `samplerNames` and blends them with an animated wipe driven by `uTime`.
 *   - `setEffectFloat2` feeds `uResolution`; `setEffectTexture` binds each
 *     sampler to its pre-assigned unit; `executeWhenCompiled` confirms link.
 */

const CHECKER_SIZE = 64;
const CHECKER_CELL = 8;

/** Build a crisp two-tone checkerboard as a tightly-packed RGBA `Uint8Array`. */
function makeCheckerboard(): Uint8Array {
    const data = new Uint8Array(CHECKER_SIZE * CHECKER_SIZE * 4);
    for (let y = 0; y < CHECKER_SIZE; y++) {
        for (let x = 0; x < CHECKER_SIZE; x++) {
            const cell = (((x / CHECKER_CELL) | 0) + ((y / CHECKER_CELL) | 0)) & 1;
            const i = (y * CHECKER_SIZE + x) * 4;
            if (cell === 0) {
                data[i] = 28;
                data[i + 1] = 36;
                data[i + 2] = 64;
            } else {
                data[i] = 88;
                data[i + 1] = 168;
                data[i + 2] = 255;
            }
            data[i + 3] = 255;
        }
    }
    return data;
}

/** Render a smooth, colourful pattern to an offscreen 2D canvas and return it
 *  as a PNG `data:` URL — the input for the async `loadTexture2D` path. */
function makeGradientPngDataUrl(): string {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d");
    if (ctx === null) {
        throw new Error("scene3: 2D context unavailable for texture generation");
    }
    const g = ctx.createLinearGradient(0, 0, 256, 256);
    g.addColorStop(0, "#ff5d73");
    g.addColorStop(0.5, "#ffd166");
    g.addColorStop(1, "#06d6a0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(48 + i * 40, 80 + ((i * 53) % 120), 26, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.55)" : "rgba(10,12,24,0.45)";
        ctx.fill();
    }
    return c.toDataURL("image/png");
}

/**
 * Parse the parity harness's `?seekTime=<seconds>` query parameter.
 *
 * Returns the freeze time in seconds, or `null` when the parameter is absent or
 * not a finite number — in which case the scene animates on the wall clock. The
 * deterministic freeze is what makes a lite render directly comparable to the
 * Babylon.js reference (see tests/gl/parity and lab/gl/src/babylon-ref-scene3.ts).
 */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
uniform vec2 uResolution;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    // texA: tiled checkerboard, aspect-corrected so the squares stay square.
    vec2 uvA = vec2(vUv.x * aspect, vUv.y) * 3.0;
    vec3 a = texture(uTexA, uvA).rgb;
    // texB: the smoothly-decoded PNG, sampled across the whole quad.
    vec3 b = texture(uTexB, vUv).rgb;
    // Animated diagonal wipe blending the two samplers.
    float wipe = smoothstep(-0.35, 0.35, sin(uTime * 0.6) - (vUv.x - 0.5) * 2.0);
    vec3 col = mix(a, b, wipe);
    // Soft vignette using the resolution-derived aspect.
    vec2 q = vUv - 0.5;
    q.x *= aspect;
    col *= 1.0 - 0.4 * dot(q, q);
    glFragColor = vec4(col, 1.0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });
const gl = engine.gl;

// (a) Raw checkerboard — crisp cells via NEAREST filtering + REPEAT wrapping.
const texA = createRawTexture(engine, makeCheckerboard(), CHECKER_SIZE, CHECKER_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, {
    minFilter: gl.NEAREST,
    magFilter: gl.NEAREST,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
});

// (b) Async PNG decode — usable immediately (1x1 placeholder), swaps in the
// decoded image once ready while keeping the same texture handle.
const texB = loadTexture2D(engine, makeGradientPngDataUrl(), {
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
});

const wrapper = createEffectWrapper(engine, {
    name: "gl-scene3-textured",
    fragmentSource: FRAGMENT_SOURCE,
    uniformNames: ["uTime", "uResolution"],
    samplerNames: ["uTexA", "uTexB"],
});
const effect = wrapper.effect;

executeWhenCompiled(engine, effect, () => {
    console.log("scene3: textured-quad effect compiled — two samplers ready");
});

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, effect)) {
        return;
    }
    resizeGLEngine(engine);
    setViewport(engine);
    applyEffectWrapper(wrapper);
    // Frozen capture pins uTime to seekTime; otherwise advance on the wall clock.
    const uTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
    setEffectFloat(engine, effect, "uTime", uTime);
    setEffectFloat2(engine, effect, "uResolution", canvas.width, canvas.height);
    setEffectTexture(engine, effect, "uTexA", texA);
    setEffectTexture(engine, effect, "uTexB", texB);
    drawEffect(engine);
    // Hold readiness until the async PNG (texB) has decoded so the captured
    // frame includes it — the deterministic freeze must match the BJS reference,
    // whose checkerboard + gradient are both ready synchronously.
    if (!firstFrameDrawn && texB.isReady) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "1";
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            // Deterministic single-frame capture: freeze + halt so the
            // screenshot is stable and matches the BJS reference exactly.
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
