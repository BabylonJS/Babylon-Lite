import {
    applyEffectWrapper,
    createEffectWrapper,
    createGLEngine,
    createRawTexture,
    drawEffect,
    GLBlendMode,
    isEffectReady,
    resizeGLEngine,
    runRenderLoop,
    setViewport,
    stopRenderLoop,
} from "babylon-lite-gl";
import { createSpriteRenderer, renderSprites, type GLSprite } from "babylon-lite-gl/sprites";

/**
 * Scene 4 — Sprites.
 *
 * Demonstrates the `babylon-lite-gl/sprites` sub-entry:
 *   - A procedural 64x64 RGBA "glow disc" sprite sheet built with
 *     `createRawTexture` (single cell, white core with a soft alpha falloff so
 *     the per-sprite tint fully controls each sprite's hue).
 *   - `createSpriteRenderer` with `cellWidth = cellHeight = 64` and
 *     `GLBlendMode.ALPHA`, then `renderSprites` once per frame.
 *
 * Matrix convention (verified against `SPRITE_VERTEX_SOURCE`):
 *   `gl_Position = projection * (view * position + rotatedCorner)`.
 * With an IDENTITY view AND IDENTITY projection, `position.xy` maps directly to
 * clip space `[-1, 1]` and `width`/`height` are full-extent clip-space units, so
 * a `width` of `0.2` spans `[-0.1, +0.1]` around the sprite centre.
 */

const SHEET_SIZE = 64;
const SPRITE_COUNT = 64;
const GRID = 8;

/** Column-major identity 4x4 — reused for both the view and projection matrix
 *  so sprite positions live directly in clip space. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Build a white radial "glow disc" with a soft alpha falloff (one cell). */
function makeGlowDisc(): Uint8Array {
    const data = new Uint8Array(SHEET_SIZE * SHEET_SIZE * 4);
    const centre = (SHEET_SIZE - 1) / 2;
    const radius = SHEET_SIZE / 2;
    for (let y = 0; y < SHEET_SIZE; y++) {
        for (let x = 0; x < SHEET_SIZE; x++) {
            const dx = x - centre;
            const dy = y - centre;
            const d = Math.sqrt(dx * dx + dy * dy) / radius;
            const fall = Math.max(0, 1 - d);
            const alpha = fall * fall; // soft-edged disc
            const i = (y * SHEET_SIZE + x) * 4;
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = Math.round(255 * alpha);
        }
    }
    return data;
}

/** Allocation-free HSV->RGB writing straight into a sprite's tint object. */
function hsvToColor(h: number, s: number, v: number, out: { r: number; g: number; b: number }): void {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (((i % 6) + 6) % 6) {
        case 0:
            out.r = v;
            out.g = t;
            out.b = p;
            break;
        case 1:
            out.r = q;
            out.g = v;
            out.b = p;
            break;
        case 2:
            out.r = p;
            out.g = v;
            out.b = t;
            break;
        case 3:
            out.r = p;
            out.g = q;
            out.b = v;
            break;
        case 4:
            out.r = t;
            out.g = p;
            out.b = v;
            break;
        default:
            out.r = v;
            out.g = p;
            out.b = q;
            break;
    }
}

const BACKGROUND_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
void main() {
    vec3 top = vec3(0.04, 0.05, 0.09);
    vec3 bot = vec3(0.10, 0.12, 0.22);
    glFragColor = vec4(mix(bot, top, vUv.y), 1.0);
}`;

/**
 * Parse the parity harness's `?seekTime=<seconds>` query parameter.
 *
 * Returns the freeze time in seconds, or `null` when the parameter is absent or
 * not a finite number — in which case the scene animates on the wall clock. The
 * deterministic freeze is what makes a lite render directly comparable to the
 * Babylon.js reference (see tests/gl/parity and lab/gl/src/babylon-ref-scene4.ts).
 */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });
const gl = engine.gl;

const sheet = createRawTexture(engine, makeGlowDisc(), SHEET_SIZE, SHEET_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, {
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
});

const renderer = createSpriteRenderer(engine, {
    capacity: SPRITE_COUNT,
    cellWidth: SHEET_SIZE,
    cellHeight: SHEET_SIZE,
    texture: sheet,
    blendMode: GLBlendMode.ALPHA,
});

// Preallocate every sprite once; the render loop only mutates fields in place.
const sprites: GLSprite[] = [];
for (let i = 0; i < SPRITE_COUNT; i++) {
    sprites.push({
        position: { x: 0, y: 0, z: 0 },
        width: 0.18,
        height: 0.18,
        angle: 0,
        cellIndex: 0,
        color: { r: 1, g: 1, b: 1, a: 0.9 },
    });
}

const background = createEffectWrapper(engine, { name: "gl-scene4-bg", fragmentSource: BACKGROUND_FRAGMENT });
const bgEffect = background.effect;

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, (dt) => {
    // Gate on BOTH the background effect and the sprite renderer's effect (plus
    // the sheet) so the frozen capture always includes the sprites — matching
    // the BJS reference, whose sprite shaders also load before its first frame.
    if (!isEffectReady(engine, bgEffect) || !isEffectReady(engine, renderer._effect) || !sheet.isReady) {
        return;
    }
    resizeGLEngine(engine);
    setViewport(engine);

    // Opaque background (blend is left DISABLED by renderSprites' auto-reset).
    applyEffectWrapper(background);
    drawEffect(engine);

    // Frozen capture pins the animation clock to seekTime; else the wall clock.
    const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
    for (let i = 0; i < SPRITE_COUNT; i++) {
        const sprite = sprites[i];
        if (sprite === undefined) {
            continue;
        }
        const col = sprite.color;
        if (col === undefined) {
            continue;
        }
        const gx = i % GRID;
        const gy = (i / GRID) | 0;
        const phase = i * 0.7;
        const baseX = (gx / (GRID - 1)) * 1.7 - 0.85;
        const baseY = (gy / (GRID - 1)) * 1.7 - 0.85;
        sprite.position.x = baseX + 0.08 * Math.cos(t * 0.8 + phase);
        sprite.position.y = baseY + 0.08 * Math.sin(t * 1.1 + phase);
        sprite.angle = t * 0.6 + phase;
        const size = 0.18 + 0.05 * Math.sin(t * 1.3 + phase);
        sprite.width = size;
        sprite.height = size;
        const hue = (i / SPRITE_COUNT + t * 0.05) % 1;
        hsvToColor(hue, 0.7, 1.0, col);
    }
    renderSprites(renderer, sprites, dt, IDENTITY, IDENTITY);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "2";
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
