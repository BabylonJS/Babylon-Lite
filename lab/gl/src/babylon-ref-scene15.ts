import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { SpriteRenderer } from "@babylonjs/core/Sprites/spriteRenderer.js";
import { ThinSprite } from "@babylonjs/core/Sprites/thinSprite.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
// Side-effect import: RawTexture.CreateRGBATexture relies on the engine.rawTexture
// extension patching ThinEngine.prototype.createRawTexture.
import "@babylonjs/core/Engines/Extensions/engine.rawTexture.js";
// Side-effect import: SpriteRenderer uploads its vertex data via Buffer.update ->
// ThinEngine.prototype.updateDynamicVertexBuffer (engine.dynamicBuffer extension).
import "@babylonjs/core/Engines/Extensions/engine.dynamicBuffer.js";
// Side-effect import: SpriteRenderer.render calls engine.setAlphaMode for blending
// (ThinEngine.prototype.setAlphaMode lives in the engine.alpha extension).
import "@babylonjs/core/Engines/Extensions/engine.alpha.js";

/**
 * Babylon.js reference for GL Scene 15 — Multiple Sprite Renderers.
 *
 * Reproduces lab/gl/src/scene15.ts (two `@babylonjs/lite-gl/sprites` renderers
 * over a glow-disc sheet and a ring sheet) with TWO real Babylon `SpriteRenderer`
 * instances + `ThinSprite`s, so the parity harness can diff the two pixel-for-pixel.
 *
 * Like scene4's reference: `scene = null` compiles NO sprite defines (no FOG /
 * PIXEL_PERFECT / LOGARITHMICDEPTH), `disableDepthWrite = true` drops the alpha-test
 * depth pre-pass, `blendMode = ALPHA_COMBINE` + `autoResetAlpha = true` mirror lite-gl's
 * `GLBlendMode.ALPHA` + auto-reset, and identity view/projection puts sprite positions
 * straight in clip space. Both Babylon SpriteRenderers share Babylon's cached sprite
 * effect — the faithful reference of lite-gl's two renderers sharing one program.
 *
 * The two procedural sheets (`makeGlowDisc` / `makeRing`) and the per-sprite
 * animation math are byte-identical to scene15.ts, so feeding the same
 * positions/sizes/angles/colors in the same draw order (bg -> discs -> rings)
 * yields the same pixels.
 */

const SHEET_SIZE = 64;
const GRID = 8;
/** Sprites per renderer (32 + 32 = the full 8x8 field, split into two layers). */
const PER_LAYER = (GRID * GRID) / 2;

/** Column-major identity 4x4 view/projection so sprite positions are clip space. */
const IDENTITY = Matrix.Identity();

/** Glow-disc sheet — byte-identical to scene15.ts's makeGlowDisc(). */
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
            const alpha = fall * fall;
            const i = (y * SHEET_SIZE + x) * 4;
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = Math.round(255 * alpha);
        }
    }
    return data;
}

/** Ring (annulus) sheet — byte-identical to scene15.ts's makeRing(). */
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

/** Allocation-free HSV->RGB — identical to scene15.ts's hsvToColor(). */
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

// ES1.00 form of scene15's BACKGROUND_FRAGMENT (Babylon auto-converts to ES3.00).
const BACKGROUND_FRAGMENT = `
precision highp float;
varying vec2 vUV;
void main(void) {
    vec3 top = vec3(0.04, 0.05, 0.09);
    vec3 bot = vec3(0.10, 0.12, 0.22);
    gl_FragColor = vec4(mix(bot, top, vUV.y), 1.0);
}`;

/** Animate one sprite at grid index `i` and time `t` — identical math to scene15.ts. */
function updateSprite(sprite: ThinSprite, i: number, t: number, sizeBase: number, sizeAmp: number, hueShift: number): void {
    const col = sprite.color;
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

    function makeSheet(data: Uint8Array): RawTexture {
        const tex = RawTexture.CreateRGBATexture(data, SHEET_SIZE, SHEET_SIZE, engine, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
        tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        return tex;
    }
    const discSheet = makeSheet(makeGlowDisc());
    const ringSheet = makeSheet(makeRing());

    function makeRenderer(sheet: RawTexture): SpriteRenderer {
        const r = new SpriteRenderer(engine, PER_LAYER, 0.01, null);
        r.texture = sheet;
        r.cellWidth = SHEET_SIZE;
        r.cellHeight = SHEET_SIZE;
        r.blendMode = Constants.ALPHA_COMBINE; // = lite GLBlendMode.ALPHA
        r.autoResetAlpha = true; // reset to DISABLE after (lite parity)
        r.disableDepthWrite = true; // no depth pre-pass (lite parity)
        r.fogEnabled = false;
        return r;
    }
    // Two SpriteRenderers — they share Babylon's cached sprite effect (the faithful
    // reference of lite-gl's two renderers sharing one program).
    const discRenderer = makeRenderer(discSheet);
    const ringRenderer = makeRenderer(ringSheet);

    function makeSprites(): ThinSprite[] {
        const arr: ThinSprite[] = [];
        for (let j = 0; j < PER_LAYER; j++) {
            const sprite = new ThinSprite();
            sprite.position = { x: 0, y: 0, z: 0 };
            sprite.width = 0.18;
            sprite.height = 0.18;
            sprite.angle = 0;
            sprite.cellIndex = 0;
            sprite.color = { r: 1, g: 1, b: 1, a: 0.9 };
            arr.push(sprite);
        }
        return arr;
    }
    const discSprites = makeSprites();
    const ringSprites = makeSprites();

    const renderer = new EffectRenderer(engine);
    const background = new EffectWrapper({ engine, name: "gl-scene15-bg-ref", fragmentShader: BACKGROUND_FRAGMENT, useShaderStore: false });

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let firstFrameDrawn = false;

    background.effect.executeWhenCompiled(() => {
        engine.runRenderLoop(() => {
            // Wait for both sprite effects (async) + both sheets before the first frame.
            const discEffect = discRenderer._drawWrapperBase?.effect;
            const ringEffect = ringRenderer._drawWrapperBase?.effect;
            if (
                discEffect === null ||
                discEffect === undefined ||
                ringEffect === null ||
                ringEffect === undefined ||
                !discEffect.isReady() ||
                !ringEffect.isReady() ||
                !discSheet.isReady() ||
                !ringSheet.isReady()
            ) {
                return;
            }
            engine.resize();
            const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

            // Opaque background (engine alpha mode stays DISABLE).
            renderer.render(background);

            for (let j = 0; j < PER_LAYER; j++) {
                updateSprite(discSprites[j]!, j, t, 0.18, 0.05, 0.0);
                updateSprite(ringSprites[j]!, PER_LAYER + j, t, 0.16, 0.04, 0.5);
            }
            // Draw both layers in order (bg -> discs -> rings), ALPHA blend, clip space.
            discRenderer.render(discSprites, 0, IDENTITY, IDENTITY);
            ringRenderer.render(ringSprites, 0, IDENTITY, IDENTITY);

            if (!firstFrameDrawn) {
                firstFrameDrawn = true;
                canvas.dataset.drawCalls = "3";
                canvas.dataset.initMs = String(performance.now() - initStart);
                canvas.dataset.ready = "true";
                if (seekTime !== null) {
                    canvas.dataset.animationFrozen = "true";
                    engine.stopRenderLoop();
                }
            }
        });
    });

    window.addEventListener("resize", () => engine.resize());
})();
