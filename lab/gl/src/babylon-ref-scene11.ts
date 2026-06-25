import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { ThinTexture } from "@babylonjs/core/Materials/Textures/thinTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
// Side-effect import: createRenderTargetTexture is patched onto ThinEngine.prototype
// by the renderTarget extension (bindFramebuffer / unBindFramebuffer are core).
import "@babylonjs/core/Engines/Extensions/engine.renderTarget.js";

/**
 * Babylon.js reference for GL Scene 11 — Stencil Masking.
 *
 * Reproduces lab/gl/src/scene11.ts (which uses @babylonjs/lite-gl/depth-stencil's
 * generateRenderTargetStencil + setStencilState + setColorMask) with Babylon's
 * ThinEngine + a stencil-bearing `createRenderTargetTexture` + `EffectRenderer`,
 * so the parity harness can diff the two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - The render target is created WITH a packed depth+stencil buffer
 *    (`generateDepthBuffer:true, generateStencilBuffer:true` → DEPTH24_STENCIL8 on
 *    DEPTH_STENCIL_ATTACHMENT), the same attachment lite-gl's
 *    `generateRenderTargetStencil` installs.
 *  - PASS 1 clears the RT (colour + stencil → 0) then stamps the stencil plane to
 *    1 inside a centred disc: stencil `func = ALWAYS`, `ref = 1`, op
 *    `KEEP/KEEP/REPLACE`, with colour writes masked OFF (`setColorWrite(false)`).
 *    The disc fragment `discard`s outside `length(vUV-0.5) >= R`, so only the
 *    inside is stamped — exactly lite-gl's PASS 1.
 *  - PASS 2 draws a fullscreen animated radial gradient with stencil
 *    `func = EQUAL`, `ref = 1`, op `KEEP/KEEP/KEEP` (no stencil writes) and colour
 *    writes back on, so it lands ONLY where the plane equals 1 (inside the disc).
 *  - COMPOSITE disables the stencil test and samples the RT fullscreen with the
 *    SAME aspect-corrected vignette.
 *  - The stencil state is driven through `engine.stencilState` (front + back set
 *    identically, matching lite-gl's non-separate `gl.stencilFunc`/`gl.stencilOp`);
 *    the EffectRenderer machinery (fullscreen quad geometry, viewport, the `scale`
 *    uniform) is identical to the other GL references.
 *  - Every shape depends ONLY on `length(vUV - 0.5)` and the composite samples at
 *    the same UV, so the round-trip is invariant to any FBO sampling-origin /
 *    Y-flip difference between the two engines.
 *  - Fragments are the SAME expressions as scene11 in ES1.00 form (varying /
 *    gl_FragColor / texture2D); Babylon's WebGL2 processor converts to ES3.00.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE round-trip at
 * uTime=seekTime then stamps dataset.animationFrozen="true" and stops the loop.
 */

const RT_SIZE = 512;

/** Disc radius (in UV space, centred at 0.5). Identical literal to scene11.ts. */
const DISC_RADIUS = 0.4;

/** RGBA clear colour of the render target — identical to scene11.ts. */
const CLEAR_R = 0.06;
const CLEAR_G = 0.07;
const CLEAR_B = 0.11;

const DISC_SHADER = `
precision highp float;
varying vec2 vUV;
void main(void) {
    float r = length(vUV - 0.5);
    if (r > ${DISC_RADIUS}) {
        discard;
    }
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
}`;

const GRADIENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform float uTime;
void main(void) {
    float r = length(vUV - 0.5);
    float rings = 0.5 + 0.5 * cos(r * 34.0 - uTime * 1.5);
    vec3 palette = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + r * 6.2832 + uTime * 0.4);
    gl_FragColor = vec4(palette * rings, 1.0);
}`;

const COMPOSITE_SHADER = `
precision highp float;
varying vec2 vUV;
uniform vec2 uResolution;
uniform sampler2D uRt;
void main(void) {
    vec3 col = texture2D(uRt, vUV).rgb;
    vec2 q = vUV - 0.5;
    q.x *= uResolution.x / max(uResolution.y, 1.0);
    float r = length(q);
    col *= 1.0 - 0.5 * r * r;
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

    // stencil:true allocates a stencil plane (the RT carries its own, but this
    // keeps the engine's stencil path fully active). Otherwise identical to the
    // other GL references' engine construction.
    const engine = new ThinEngine(canvas, false, { alpha: false, premultipliedAlpha: false, stencil: true }, false);

    // Offscreen color target with a PACKED depth+stencil buffer — matches lite-gl's
    // createRenderTarget(generateDepthBuffer:true) + generateRenderTargetStencil
    // (DEPTH24_STENCIL8 on DEPTH_STENCIL_ATTACHMENT). RGBA8, BILINEAR/CLAMP.
    const rtw = engine.createRenderTargetTexture(RT_SIZE, {
        generateDepthBuffer: true,
        generateStencilBuffer: true,
        generateMipMaps: false,
        samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
        format: Constants.TEXTUREFORMAT_RGBA,
    });
    // Wrap the RT's color attachment so the composite effect can sample it.
    const rtSampleTexture = new ThinTexture(rtw.texture);
    rtSampleTexture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    rtSampleTexture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

    const renderer = new EffectRenderer(engine);
    const discWrapper = new EffectWrapper({
        engine,
        name: "gl-scene11-stencil-disc-ref",
        fragmentShader: DISC_SHADER,
        uniforms: [],
        samplers: [],
        useShaderStore: false,
    });
    const gradientWrapper = new EffectWrapper({
        engine,
        name: "gl-scene11-stencil-gradient-ref",
        fragmentShader: GRADIENT_SHADER,
        uniforms: ["uTime"],
        samplers: [],
        useShaderStore: false,
    });
    const compositeWrapper = new EffectWrapper({
        engine,
        name: "gl-scene11-stencil-composite-ref",
        fragmentShader: COMPOSITE_SHADER,
        uniforms: ["uResolution"],
        samplers: ["uRt"],
        useShaderStore: false,
    });

    /** Set the global stencil state (front + back identical, mirroring lite-gl's
     *  non-separate gl.stencilFunc / gl.stencilOp). */
    function setStencil(test: boolean, mask: number, func: number, ref: number, funcMask: number, fail: number, zfail: number, zpass: number): void {
        const st = engine.stencilState;
        st.stencilTest = test;
        st.stencilMask = mask;
        st.stencilFunc = func;
        st.stencilBackFunc = func;
        st.stencilFuncRef = ref;
        st.stencilFuncMask = funcMask;
        st.stencilOpStencilFail = fail;
        st.stencilOpDepthFail = zfail;
        st.stencilOpStencilDepthPass = zpass;
        st.stencilBackOpStencilFail = fail;
        st.stencilBackOpDepthFail = zfail;
        st.stencilBackOpStencilDepthPass = zpass;
    }

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let currentTime = 0;

    // PASS 1 — the RT is bound when this fires (EffectRenderer.render bound it).
    // Clear colour + stencil, then stamp stencil = 1 inside the disc with colour
    // writes masked off.
    discWrapper.onApplyObservable.add(() => {
        engine.setColorWrite(true);
        // Clear respects the global stencil write mask, so enable it first.
        setStencil(true, 0xff, Constants.ALWAYS, 1, 0xff, Constants.KEEP, Constants.KEEP, Constants.REPLACE);
        engine.clear({ r: CLEAR_R, g: CLEAR_G, b: CLEAR_B, a: 1 }, true, false, true);
        // Disc pass writes stencil only (colour masked off).
        engine.setColorWrite(false);
    });

    // PASS 2 — gradient admitted only where stencil == 1 (inside the disc).
    gradientWrapper.onApplyObservable.add(() => {
        engine.setColorWrite(true);
        setStencil(true, 0x00, Constants.EQUAL, 1, 0xff, Constants.KEEP, Constants.KEEP, Constants.KEEP);
        gradientWrapper.effect.setFloat("uTime", currentTime);
    });

    // COMPOSITE — applyEffectWrapper already disabled the stencil test; just sample.
    compositeWrapper.onApplyObservable.add(() => {
        engine.setColorWrite(true);
        compositeWrapper.effect.setFloat2("uResolution", canvas.width, canvas.height);
        compositeWrapper.effect.setTexture("uRt", rtSampleTexture);
    });

    let firstFrameDrawn = false;
    engine.runRenderLoop(() => {
        // All three passes must be link-complete before the round-trip is valid.
        if (!discWrapper.effect.isReady() || !gradientWrapper.effect.isReady() || !compositeWrapper.effect.isReady()) {
            return;
        }
        engine.resize();
        currentTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

        // ── PASS 1: clear + stamp the disc into the stencil plane ──
        renderer.render(discWrapper, rtw);
        // ── PASS 2: draw the gradient, stencil-masked to the disc ──
        renderer.render(gradientWrapper, rtw);
        // ── COMPOSITE: sample the masked RT to the screen ──
        renderer.render(compositeWrapper);

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

    window.addEventListener("resize", () => engine.resize());
})();
