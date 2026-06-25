import { applyEffectWrapper, createEffectWrapper, createGLEngine, drawEffect, isEffectReady, resizeGLEngine, runRenderLoop, setEffectTexture, setViewport, stopRenderLoop } from "babylon-lite-gl";
import { createDynamicTexture, updateDynamicTexture } from "babylon-lite-gl/dynamic-texture";

/**
 * Scene 13 — Dynamic Texture.
 *
 * Demonstrates the `babylon-lite-gl/dynamic-texture` sub-entry:
 *   - An offscreen 2D `<canvas>` is repainted every frame with the Canvas 2D API
 *     using ONLY platform-deterministic primitives (filled `fillRect`s, `arc`
 *     discs and a `createLinearGradient`) — NO text, whose rasterisation varies
 *     across OSes and would inflate MAD.
 *   - `createDynamicTexture(engine, w, h)` allocates a blank RGBA8 texture
 *     (LINEAR/LINEAR, CLAMP/CLAMP, no mipmaps by default — i.e. BILINEAR).
 *   - `updateDynamicTexture(engine, tex, canvas)` re-uploads the canvas each
 *     frame; the result is sampled by a fullscreen effect via `setEffectTexture`.
 *
 * Orientation: lite-gl uploads the canvas WITHOUT a vertical flip (`invertY`
 * defaults to `false`), but the default fullscreen vertex shader emits `vUv.y = 0`
 * at the bottom of the screen while a 2D canvas has `y = 0` at the TOP. The
 * fragment therefore flips V (`1.0 - vUv.y`) to present the 2D canvas the right
 * way up — verified against the thumbnail (the palette bar sits at the top).
 */

const TAU = Math.PI * 2;
const SURFACE_SIZE = 256;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform sampler2D uTex;
void main() {
    // V-flip: the canvas is uploaded top-row-first with no invertY, so undo it
    // here to display the 2D content upright.
    vec3 c = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb;
    glFragColor = vec4(c, 1.0);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });

/**
 * Parse the parity harness's `?seekTime=<seconds>` query parameter.
 *
 * Returns the freeze time in seconds, or `null` when the parameter is absent or
 * not a finite number — in which case the scene animates on the wall clock. The
 * deterministic freeze is what makes a lite render directly comparable to the
 * Babylon.js reference (see tests/gl/parity and lab/gl/src/babylon-ref-scene13.ts).
 */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

// Offscreen 2D canvas that backs the dynamic texture.
const surface = document.createElement("canvas");
surface.width = SURFACE_SIZE;
surface.height = SURFACE_SIZE;
const ctx = surface.getContext("2d");
if (ctx === null) {
    throw new Error("scene13: 2D context unavailable for the dynamic texture");
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

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
drawSurface(0);

// Defaults: LINEAR/LINEAR, CLAMP/CLAMP, no mipmaps (BILINEAR) — see header.
const tex = createDynamicTexture(engine, SURFACE_SIZE, SURFACE_SIZE);

const wrapper = createEffectWrapper(engine, {
    name: "gl-scene13-dynamic-texture",
    fragmentSource: FRAGMENT_SOURCE,
    samplerNames: ["uTex"],
});
const effect = wrapper.effect;

let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, effect)) {
        return;
    }
    // Frozen capture pins the surface-animation clock to seekTime; otherwise
    // advance on the wall clock.
    const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
    drawSurface(t);
    // invertY defaults to false (canvas top row -> texture t=0); the fragment
    // flips V to present it upright.
    updateDynamicTexture(engine, tex, surface);

    resizeGLEngine(engine);
    setViewport(engine);
    applyEffectWrapper(wrapper);
    setEffectTexture(engine, effect, "uTex", tex);
    drawEffect(engine);

    if (!firstFrameDrawn) {
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
