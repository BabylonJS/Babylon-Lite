import { applyEffectWrapper, createEffectWrapper, createGLEngine, createRawTexture, drawEffect, GLBlendMode, isEffectReady, resizeGLEngine, runRenderLoop, setViewport, stopRenderLoop } from "babylon-lite-gl";
import { createSpriteRenderer, renderSprites, type GLSprite } from "babylon-lite-gl/sprites";

/**
 * Scene 15 — Multiple Sprite Renderers (shared program).
 *
 * Two independent `babylon-lite-gl/sprites` renderers draw two layers over two
 * different procedural sheets:
 *   - a "discs" layer (soft glow discs, top half of the field), and
 *   - a "rings" layer (hollow annuli, bottom half),
 * both with `GLBlendMode.ALPHA`, drawn back-to-front after a gradient background.
 *
 * The point of the scene is the perf path, not the visuals: every
 * `createSpriteRenderer` compiles its sprite shader through the engine's
 * source-keyed effect cache, so the TWO renderers SHARE one `WebGLProgram`.
 * Drawing both therefore issues `gl.useProgram` only ONCE — no redundant program
 * switch per renderer (the cache + current-program cache working together). The
 * scene stamps `canvas.dataset.sharedProgram` so this is observable from a
 * capture, and `tests/gl/unit/sprites.test.ts` asserts it deterministically.
 *
 * Babylon reference: `babylon-ref-scene15.ts` reproduces the same two layers with
 * two real `SpriteRenderer` instances (which likewise share Babylon's cached
 * sprite effect), so the parity harness can diff the two pixel-for-pixel.
 */

const SHEET_SIZE = 64;
const GRID = 8;
/** Sprites per renderer (32 + 32 = the full 8x8 field, split into two layers). */
const PER_LAYER = (GRID * GRID) / 2;

/** Column-major identity 4x4 — reused for both view and projection so sprite
 *  positions live directly in clip space (matches scene4 / scene15 reference). */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Build a white radial "glow disc" with a soft alpha falloff (one cell).
 *  Byte-identical to scene4's makeGlowDisc(). */
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

/** Build a white "ring" (annulus) sheet — alpha peaks at a mid radius and falls
 *  to zero at both the centre and the rim, giving a hollow sprite. Deterministic
 *  (and byte-identical to the reference's makeRing()). */
function makeRing(): Uint8Array {
    const data = new Uint8Array(SHEET_SIZE * SHEET_SIZE * 4);
    const centre = (SHEET_SIZE - 1) / 2;
    const radius = SHEET_SIZE / 2;
    for (let y = 0; y < SHEET_SIZE; y++) {
        for (let x = 0; x < SHEET_SIZE; x++) {
            const dx = x - centre;
            const dy = y - centre;
            const d = Math.sqrt(dx * dx + dy * dy) / radius;
            const ring = Math.max(0, 1 - Math.abs(d - 0.62) * 5);
            const alpha = ring * ring;
            const i = (y * SHEET_SIZE + x) * 4;
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = Math.round(255 * alpha);
        }
    }
    return data;
}

/** Allocation-free HSV->RGB writing straight into a sprite's tint object.
 *  Identical to scene4's hsvToColor(). */
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

/** Animate one sprite at grid index `i` (0..63) and time `t`. `sizeBase`/`sizeAmp`
 *  and `hueShift` differ per layer so the two renderers read visually distinct.
 *  The position/angle math is identical to scene4 so parity is trivially exact. */
function updateSprite(sprite: GLSprite, i: number, t: number, sizeBase: number, sizeAmp: number, hueShift: number): void {
    const col = sprite.color;
    if (col === undefined) {
        return;
    }
    const gx = i % GRID;
    const gy = (i / GRID) | 0;
    const phase = i * 0.7;
    const baseX = (gx / (GRID - 1)) * 1.7 - 0.85;
    const baseY = (gy / (GRID - 1)) * 1.7 - 0.85;
    sprite.position.x = baseX + 0.08 * Math.cos(t * 0.8 + phase);
    sprite.position.y = baseY + 0.08 * Math.sin(t * 1.1 + phase);
    sprite.angle = t * 0.6 + phase;
    const size = sizeBase + sizeAmp * Math.sin(t * 1.3 + phase);
    sprite.width = size;
    sprite.height = size;
    const hue = (i / (GRID * GRID) + hueShift + t * 0.05) % 1;
    hsvToColor(hue, 0.7, 1.0, col);
}

/** Parse the parity harness's `?seekTime=<seconds>` query parameter (null when
 *  absent — the scene then animates on the wall clock). */
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

const discSheet = createRawTexture(engine, makeGlowDisc(), SHEET_SIZE, SHEET_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, { minFilter: gl.LINEAR, magFilter: gl.LINEAR });
const ringSheet = createRawTexture(engine, makeRing(), SHEET_SIZE, SHEET_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, { minFilter: gl.LINEAR, magFilter: gl.LINEAR });

// TWO independent sprite renderers. Both compile the identical sprite shader, so
// the engine's source-keyed effect cache hands them ONE shared WebGLProgram.
const discRenderer = createSpriteRenderer(engine, { capacity: PER_LAYER, cellWidth: SHEET_SIZE, cellHeight: SHEET_SIZE, texture: discSheet, blendMode: GLBlendMode.ALPHA });
const ringRenderer = createSpriteRenderer(engine, { capacity: PER_LAYER, cellWidth: SHEET_SIZE, cellHeight: SHEET_SIZE, texture: ringSheet, blendMode: GLBlendMode.ALPHA });

// Preallocate each layer's sprites once; the render loop mutates fields in place.
const discSprites: GLSprite[] = [];
const ringSprites: GLSprite[] = [];
for (let j = 0; j < PER_LAYER; j++) {
    discSprites.push({ position: { x: 0, y: 0, z: 0 }, width: 0.18, height: 0.18, angle: 0, cellIndex: 0, color: { r: 1, g: 1, b: 1, a: 0.9 } });
    ringSprites.push({ position: { x: 0, y: 0, z: 0 }, width: 0.16, height: 0.16, angle: 0, cellIndex: 0, color: { r: 1, g: 1, b: 1, a: 0.9 } });
}

const background = createEffectWrapper(engine, { name: "gl-scene15-bg", fragmentSource: BACKGROUND_FRAGMENT });
const bgEffect = background.effect;

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, (dt) => {
    // Gate on both layers' effects + sheets so the frozen capture always includes
    // every sprite (matching the BJS reference's async sprite-shader load).
    if (!isEffectReady(engine, bgEffect) || !isEffectReady(engine, discRenderer._effect) || !isEffectReady(engine, ringRenderer._effect) || !discSheet.isReady || !ringSheet.isReady) {
        return;
    }
    resizeGLEngine(engine);
    setViewport(engine);

    // Opaque background (blend left DISABLED by the previous frame's auto-reset).
    applyEffectWrapper(background);
    drawEffect(engine);

    const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
    // Layer A = grid indices 0..31 (top half); layer B = 32..63 (bottom half).
    for (let j = 0; j < PER_LAYER; j++) {
        updateSprite(discSprites[j]!, j, t, 0.18, 0.05, 0.0);
        updateSprite(ringSprites[j]!, PER_LAYER + j, t, 0.16, 0.04, 0.5);
    }
    // Draw both layers in order (bg -> discs -> rings). Two sprite renderers, but
    // one shared program: useProgram is issued once for the discs, then elided
    // for the rings by the current-program cache.
    renderSprites(discRenderer, discSprites, dt, IDENTITY, IDENTITY);
    renderSprites(ringRenderer, ringSprites, dt, IDENTITY, IDENTITY);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "3"; // background + 2 sprite layers
        canvas.dataset.spriteRenderers = "2";
        // Observable proof of the effect cache: both renderers share one program.
        canvas.dataset.sharedProgram = String(discRenderer._effect.program === ringRenderer._effect.program);
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
