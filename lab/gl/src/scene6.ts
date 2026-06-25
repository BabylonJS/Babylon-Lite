import { applyEffectWrapper, createEffectWrapper, createGLEngine, drawEffect, isEffectReady, resizeGLEngine, runRenderLoop, setEffectTexture, setViewport, stopRenderLoop } from "babylon-lite-gl";
import { createHtmlElementTexture, GLSamplingMode, updateHtmlElementTexture } from "babylon-lite-gl/html-texture";

/**
 * Scene 6 — HTML-Element Texture.
 *
 * Demonstrates the `babylon-lite-gl/html-texture` sub-entry:
 *   - An offscreen 2D `<canvas>` is animated every frame with the Canvas 2D API.
 *   - `createHtmlElementTexture(engine, surface, { samplingMode: BILINEAR })`
 *     wraps it as a GL texture.
 *   - `updateHtmlElementTexture` re-uploads the canvas each frame; the result is
 *     sampled by a fullscreen effect via `setEffectTexture`.
 *
 * Orientation: lite-gl uploads the canvas WITHOUT a vertical flip (`invertY`
 * defaults to `false`), but the default fullscreen vertex shader emits `vUv.y = 0`
 * at the bottom of the screen while a 2D canvas has `y = 0` at the TOP. The
 * fragment therefore flips V (`1.0 - vUv.y`) to present the 2D canvas the right
 * way up — verified against the thumbnail (the "Lite GL" title sits at the top).
 */

const TAU = Math.PI * 2;
const SURFACE_SIZE = 512;

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
 * Babylon.js reference (see tests/gl/parity and lab/gl/src/babylon-ref-scene6.ts).
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
    throw new Error("scene6: 2D context unavailable for the dynamic texture");
}

/** Repaint the offscreen 2D canvas for time `t` (seconds). */
function drawSurface(t: number): void {
    if (ctx === null) {
        return;
    }
    const bg = ctx.createLinearGradient(0, 0, 0, SURFACE_SIZE);
    bg.addColorStop(0, "#10203a");
    bg.addColorStop(1, "#241033");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SURFACE_SIZE, SURFACE_SIZE);

    // Faint reference grid.
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= SURFACE_SIZE; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, SURFACE_SIZE);
        ctx.moveTo(0, i);
        ctx.lineTo(SURFACE_SIZE, i);
        ctx.stroke();
    }

    // Orbiting colour discs.
    for (let i = 0; i < 6; i++) {
        const x = 256 + 150 * Math.cos(t * 0.7 + i * 1.05);
        const y = 320 + 120 * Math.sin(t * 0.9 + i * 1.05);
        ctx.beginPath();
        ctx.arc(x, y, 34, 0, TAU);
        ctx.fillStyle = "hsl(" + ((((i * 60 + t * 40) % 360) + 360) % 360) + ", 80%, 60%)";
        ctx.fill();
    }

    // Rotating sweep hand to make the animation (and orientation) obvious.
    ctx.save();
    ctx.translate(256, 340);
    ctx.rotate(t * 1.2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -120);
    ctx.stroke();
    ctx.restore();

    // Title near the TOP — verifies upright orientation in the thumbnail.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 72px sans-serif";
    ctx.fillText("Lite GL", 256, 96 + 6 * Math.sin(t * 2));
    ctx.font = "26px sans-serif";
    ctx.fillStyle = "#9fb4ff";
    ctx.fillText("html-texture", 256, 152);
}

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
drawSurface(0);

const tex = createHtmlElementTexture(engine, surface, { samplingMode: GLSamplingMode.BILINEAR });

const wrapper = createEffectWrapper(engine, {
    name: "gl-scene6-html-texture",
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
    updateHtmlElementTexture(engine, tex);

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
