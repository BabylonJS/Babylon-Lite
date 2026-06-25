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
 * Babylon.js reference for GL Scene 4 — Sprites.
 *
 * Reproduces lab/gl/src/scene4.ts (which uses @babylonjs/lite-gl's
 * `createSpriteRenderer` + `renderSprites`) with Babylon's REAL `SpriteRenderer`
 * + `ThinSprite`, so the parity harness can diff the two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - lite-gl's sprite vertex layout, per-cell UV math and corner/rotation
 *    transform are byte-copied from Babylon's non-instanced `SpriteRenderer`
 *    (`_appendSpriteVertex`), and the lite sprite shaders are the GLSL ES 3.00
 *    translation of Babylon's `sprites.vertex` / `sprites.fragment` *color* path.
 *    With `scene = null` Babylon compiles NO defines (no FOG / PIXEL_PERFECT /
 *    LOGARITHMICDEPTH), so its active shader is exactly that color path. Feeding
 *    the SAME positions / sizes / angles / colors therefore yields the SAME
 *    pixels.
 *  - disableDepthWrite = true: lite-gl's default engine has no depth attachment
 *    and its sprite path dropped Babylon's alpha-test depth pre-pass. Setting
 *    this flag makes Babylon skip that pre-pass too, drawing the sprites in a
 *    single pass with NO depth interaction — the faithful reference of lite-gl's
 *    behavior (and 1 sprite draw call, like `renderSprites`).
 *  - blendMode ALPHA_COMBINE (2) + autoResetAlpha = true: identical to lite-gl's
 *    `GLBlendMode.ALPHA` followed by an auto-reset to DISABLE.
 *  - Identity view AND identity projection: sprite positions live directly in
 *    clip space, exactly like scene4's IDENTITY/IDENTITY pair.
 *  - The glow-disc sheet is the SAME bytes from `makeGlowDisc()` uploaded with
 *    LINEAR min+mag, invertY=false (the disc is radially symmetric, so
 *    orientation is irrelevant regardless).
 *  - Background: the SAME gradient as scene4's BACKGROUND_FRAGMENT, drawn opaque
 *    via EffectRenderer before the sprites (engine alpha mode stays DISABLE).
 *
 * Determinism: ?seekTime=<seconds> animates the sprite field at t=seekTime,
 * renders exactly ONE frame, then stamps dataset.animationFrozen="true" and stops
 * the loop. The sprite shaders load asynchronously, so the loop waits for the
 * sprite effect (and the sheet) before drawing the first comparable frame.
 */

const SHEET_SIZE = 64;
const SPRITE_COUNT = 64;
const GRID = 8;

/** Column-major identity 4x4 view/projection so sprite positions are clip space. */
const IDENTITY = Matrix.Identity();

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

// ES1.00 form of scene4's BACKGROUND_FRAGMENT (Babylon auto-converts to ES3.00).
const BACKGROUND_FRAGMENT = `
precision highp float;
varying vec2 vUV;
void main(void) {
    vec3 top = vec3(0.04, 0.05, 0.09);
    vec3 bot = vec3(0.10, 0.12, 0.22);
    gl_FragColor = vec4(mix(bot, top, vUV.y), 1.0);
}`;

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

    // Glow-disc sheet — LINEAR min+mag, invertY=false (radially symmetric).
    const sheet = RawTexture.CreateRGBATexture(
        makeGlowDisc(),
        SHEET_SIZE,
        SHEET_SIZE,
        engine,
        false,
        false,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        Constants.TEXTURETYPE_UNSIGNED_BYTE
    );
    sheet.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    sheet.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

    // Babylon's real sprite renderer (scene=null → no scene-dependent defines).
    const spriteRenderer = new SpriteRenderer(engine, SPRITE_COUNT, 0.01, null);
    spriteRenderer.texture = sheet;
    spriteRenderer.cellWidth = SHEET_SIZE;
    spriteRenderer.cellHeight = SHEET_SIZE;
    spriteRenderer.blendMode = Constants.ALPHA_COMBINE; // = lite GLBlendMode.ALPHA
    spriteRenderer.autoResetAlpha = true; // reset to DISABLE after (lite parity)
    spriteRenderer.disableDepthWrite = true; // no depth pre-pass (lite parity)
    spriteRenderer.fogEnabled = false;

    // Preallocate every sprite once; the loop only mutates fields in place.
    const sprites: ThinSprite[] = [];
    for (let i = 0; i < SPRITE_COUNT; i++) {
        const sprite = new ThinSprite();
        sprite.position = { x: 0, y: 0, z: 0 };
        sprite.width = 0.18;
        sprite.height = 0.18;
        sprite.angle = 0;
        sprite.cellIndex = 0;
        sprite.color = { r: 1, g: 1, b: 1, a: 0.9 };
        sprites.push(sprite);
    }

    const renderer = new EffectRenderer(engine);
    const background = new EffectWrapper({
        engine,
        name: "gl-scene4-bg-ref",
        fragmentShader: BACKGROUND_FRAGMENT,
        useShaderStore: false,
    });

    /** Animate the sprite field at time `t` — identical math to scene4. */
    function updateSprites(t: number): void {
        for (let i = 0; i < SPRITE_COUNT; i++) {
            const sprite = sprites[i];
            if (sprite === undefined) {
                continue;
            }
            const col = sprite.color;
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
    }

    const seekTime = parseSeekTime();
    const startMs = performance.now();

    let firstFrameDrawn = false;
    background.effect.executeWhenCompiled(() => {
        engine.runRenderLoop(() => {
            // The sprite shaders load asynchronously; wait for the sprite effect
            // (and the sheet) before drawing the first comparable frame.
            const spriteEffect = spriteRenderer._drawWrapperBase?.effect;
            if (spriteEffect === null || spriteEffect === undefined || !spriteEffect.isReady() || !sheet.isReady()) {
                return;
            }
            engine.resize();
            const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

            // Opaque background (engine alpha mode stays DISABLE).
            renderer.render(background);

            // Animate + draw the sprites with ALPHA blend in clip space.
            updateSprites(t);
            spriteRenderer.render(sprites, 0, IDENTITY, IDENTITY);

            if (!firstFrameDrawn) {
                firstFrameDrawn = true;
                canvas.dataset.drawCalls = "2";
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
