import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";

/**
 * Babylon.js reference for GL Scene 7 — Sine Wave Bands.
 *
 * Renders the SAME effect as lab/gl/src/scene7.ts (which uses @babylonjs/lite-gl's
 * `runFullscreenEffect`) but via Babylon's ThinEngine + EffectRenderer +
 * EffectWrapper, so the parity harness can diff the two pixel-for-pixel.
 *
 * The effect is an ORIGINAL reimplementation inspired by
 * https://www.shadertoy.com/view/tffSDr (no license stated on the source), built
 * from public techniques: Inigo Quilez's cosine palette + layered sine bands.
 *
 * Matches lite-gl exactly: identical fullscreen quad + UVs (vUV = position*0.5+0.5),
 * the SAME fragment expression written in ES1.00 form (Babylon auto-converts to
 * ES3.00), alpha:false opaque buffer with no clear, and hardwareScalingLevel=1.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE frame at uTime=seekTime
 * then stamps dataset.animationFrozen="true" and stops the loop. Without it, the
 * scene animates on the wall clock (used by the perf harness).
 */
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform float uTime;
uniform vec2 uResolution;

const float TAU = 6.28318530718;

vec3 palette(float t) {
    return 0.5 + 0.5 * cos(TAU * (t + vec3(0.10, 0.40, 0.50)));
}

void main(void) {
    vec2 uv = vUV * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    vec3 col = vec3(0.0);
    for (int i = 0; i < 10; i++) {
        float layer = float(i) * 0.1;
        float amp = 0.25 + 0.25 * sin(uTime + layer) * (1.0 - layer);
        float phase = uTime * (1.0 - layer);
        float thickness = 0.01 + 0.001 * pow(abs(uv.x), 8.0);
        float band = uv.y + amp * sin(2.0 * (uv.x - phase));
        float bright = smoothstep(0.0, 1.0, 1.0 - abs(band) / thickness);
        col += bright * palette(0.5 * uv.x + layer - 0.5 * uTime);
    }
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

    // Mirror lite-gl's createGLEngine(canvas, { alpha: false }): opaque buffer, no
    // AA, no stencil. adaptToDeviceRatio=false keeps hardwareScalingLevel=1.
    const engine = new ThinEngine(canvas, false, { alpha: false, premultipliedAlpha: false, stencil: false }, false);

    const renderer = new EffectRenderer(engine);
    const wrapper = new EffectWrapper({
        engine,
        name: "gl-scene7-sine-bands-ref",
        fragmentShader: FRAGMENT_SHADER,
        uniforms: ["uTime", "uResolution"],
        useShaderStore: false,
    });

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let currentTime = 0;

    // uTime / uResolution are uploaded while the effect is the bound program —
    // onApply fires from EffectRenderer.applyEffectWrapper() during render().
    wrapper.onApplyObservable.add(() => {
        wrapper.effect.setFloat("uTime", currentTime);
        wrapper.effect.setFloat2("uResolution", canvas.width, canvas.height);
    });

    let firstFrameDrawn = false;
    wrapper.effect.executeWhenCompiled(() => {
        engine.runRenderLoop(() => {
            // Match resizeGLEngine: keep the backing store at clientWidth×clientHeight.
            engine.resize();
            currentTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
            renderer.render(wrapper);
            if (!firstFrameDrawn) {
                firstFrameDrawn = true;
                canvas.dataset.drawCalls = "1";
                canvas.dataset.initMs = String(performance.now() - initStart);
                canvas.dataset.ready = "true";
                if (seekTime !== null) {
                    // Deterministic single-frame capture: freeze + halt.
                    canvas.dataset.animationFrozen = "true";
                    engine.stopRenderLoop();
                }
            }
        });
    });

    window.addEventListener("resize", () => engine.resize());
})();
