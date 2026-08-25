import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
// Side-effect import: RawTexture.CreateRGBATexture relies on the engine.rawTexture
// extension patching ThinEngine.prototype.createRawTexture.
import "@babylonjs/core/Engines/Extensions/engine.rawTexture.js";

/**
 * Babylon.js reference for GL Scene 3 — Textured Quad.
 *
 * Reproduces lab/gl/src/scene3.ts (which uses @babylonjs/lite-gl's
 * createRawTexture + loadTexture2D + a two-sampler custom effect) with Babylon's
 * ThinEngine + EffectRenderer + EffectWrapper, so the parity harness can diff the
 * two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - Geometry / UV / context / size: identical to the scene1 reference (default
 *    EffectRenderer fullscreen quad, postprocess vUV, opaque buffer, hwScaling=1).
 *  - Fragment: the SAME expression as scene3, written in ES1.00 form
 *    (varying / gl_FragColor / texture2D). Babylon's WebGL2 shader processor
 *    auto-converts it to ES3.00.
 *  - texA (checkerboard): the SAME bytes from `makeCheckerboard()` uploaded with
 *    NEAREST min+mag, WRAP/WRAP and invertY=false — byte-identical to lite-gl's
 *    createRawTexture(..., { NEAREST, REPEAT }).
 *  - texB (gradient): lite-gl's `loadTexture2D` decodes a PNG via an ImageBitmap
 *    (premultiplyAlpha:"none") and uploads it with NO UNPACK_FLIP_Y, so the
 *    canvas TOP row lands at texture t=0. We draw the SAME canvas, read its
 *    pixels with getImageData (top-row-first, straight alpha — the canvas is
 *    fully opaque) and upload them via a RawTexture with invertY=false, giving
 *    the SAME canvas-top→t=0 orientation. Reading getImageData instead of
 *    round-tripping a PNG avoids ImageBitmap colour-management drift.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE frame at uTime=seekTime
 * then stamps dataset.animationFrozen="true" and stops the loop. Both raw
 * textures are ready synchronously, so the first rendered frame is complete.
 */

const CHECKER_SIZE = 64;
const CHECKER_CELL = 8;

/** Build a crisp two-tone checkerboard — identical to scene3's makeCheckerboard(). */
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

/** Draw the SAME colourful pattern scene3's makeGradientPngDataUrl() encodes and
 *  return its raw RGBA pixels (top-row-first, straight alpha). The canvas is
 *  fully opaque, so getImageData matches the decoded PNG byte-for-byte. */
function makeGradientPixels(): Uint8Array {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d");
    if (ctx === null) {
        throw new Error("babylon-ref-scene3: 2D context unavailable for texture generation");
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
    return new Uint8Array(ctx.getImageData(0, 0, 256, 256).data.buffer);
}

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform float uTime;
uniform vec2 uResolution;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
void main(void) {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    // texA: tiled checkerboard, aspect-corrected so the squares stay square.
    vec2 uvA = vec2(vUV.x * aspect, vUV.y) * 3.0;
    vec3 a = texture2D(uTexA, uvA).rgb;
    // texB: the smoothly-decoded gradient, sampled across the whole quad.
    vec3 b = texture2D(uTexB, vUV).rgb;
    // Animated diagonal wipe blending the two samplers.
    float wipe = smoothstep(-0.35, 0.35, sin(uTime * 0.6) - (vUV.x - 0.5) * 2.0);
    vec3 col = mix(a, b, wipe);
    // Soft vignette using the resolution-derived aspect.
    vec2 q = vUV - 0.5;
    q.x *= aspect;
    col *= 1.0 - 0.4 * dot(q, q);
    gl_FragColor = vec4(col, 1.0);
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

    // (a) Raw checkerboard — crisp cells via NEAREST filtering + WRAP wrapping,
    // invertY=false to match lite-gl's createRawTexture upload orientation.
    const texA = RawTexture.CreateRGBATexture(
        makeCheckerboard(),
        CHECKER_SIZE,
        CHECKER_SIZE,
        engine,
        false,
        false,
        Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        Constants.TEXTURETYPE_UNSIGNED_BYTE
    );
    texA.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texA.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;

    // (b) Gradient texture — LINEAR filtering, CLAMP wrapping, invertY=false so
    // the canvas top row lands at t=0 exactly like lite-gl's loadTexture2D.
    const texB = RawTexture.CreateRGBATexture(
        makeGradientPixels(),
        256,
        256,
        engine,
        false,
        false,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        Constants.TEXTURETYPE_UNSIGNED_BYTE
    );
    texB.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    texB.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

    const renderer = new EffectRenderer(engine);
    const wrapper = new EffectWrapper({
        engine,
        name: "gl-scene3-textured-ref",
        fragmentShader: FRAGMENT_SHADER,
        uniforms: ["uTime", "uResolution"],
        samplers: ["uTexA", "uTexB"],
        useShaderStore: false,
    });

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let currentTime = 0;

    // Uniforms + samplers are uploaded while the effect is the bound program —
    // onApply fires from EffectRenderer.applyEffectWrapper() during render().
    wrapper.onApplyObservable.add(() => {
        wrapper.effect.setFloat("uTime", currentTime);
        wrapper.effect.setFloat2("uResolution", canvas.width, canvas.height);
        wrapper.effect.setTexture("uTexA", texA);
        wrapper.effect.setTexture("uTexB", texB);
    });

    let firstFrameDrawn = false;
    wrapper.effect.executeWhenCompiled(() => {
        engine.runRenderLoop(() => {
            engine.resize();
            currentTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
            renderer.render(wrapper);
            if (!firstFrameDrawn) {
                firstFrameDrawn = true;
                canvas.dataset.drawCalls = "1";
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
