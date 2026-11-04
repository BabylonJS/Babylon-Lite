import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";

/**
 * Babylon.js reference for GL Scene 1 — Animated Gradient.
 *
 * Renders the SAME gradient as lab/gl/src/scene1.ts (which uses @babylonjs/lite-gl)
 * but via Babylon's ThinEngine + EffectRenderer + EffectWrapper, so the parity
 * harness can diff the two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - Geometry: EffectRenderer's default fullscreen quad is positions
 *    [1,1,-1,1,-1,-1,1,-1] / indices [0,1,2,0,2,3] — byte-identical to lite-gl's
 *    QUAD_POSITIONS / QUAD_INDICES (effect-renderer.ts).
 *  - UV mapping: the default "postprocess" vertex shader computes
 *    vUV = (position*0.5+0.5)*scale with scale=(1,1) — identical to lite-gl's
 *    built-in vertex shader vUv = position*0.5+0.5.
 *  - Fragment: the SAME expression as scene1, written in ES1.00 form
 *    (varying / gl_FragColor). Babylon's WebGL2 shader processor auto-converts it
 *    to ES3.00 — the target lite-gl authors directly.
 *  - Context: alpha:false (opaque drawing buffer) and NO clear; the fullscreen
 *    quad writes alpha=1 over every pixel, exactly like run-effect.ts.
 *  - Size: adaptToDeviceRatio=false pins hardwareScalingLevel=1 so the backing
 *    store is clientWidth×clientHeight (1280×720 at dpr=1), matching
 *    resizeGLEngine.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE frame at uTime=seekTime
 * then stamps dataset.animationFrozen="true" and stops the loop. Without it, the
 * scene animates on the wall clock (used by the perf harness).
 */
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform float uTime;
void main(void) {
    vec3 col = 0.5 + 0.5 * cos(uTime + vUV.xyx + vec3(0.0, 2.0, 4.0));
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
        name: "gl-scene1-gradient-ref",
        fragmentShader: FRAGMENT_SHADER,
        uniforms: ["uTime"],
        useShaderStore: false,
    });

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let currentTime = 0;

    // uTime is uploaded while the effect is the bound program — onApply fires
    // from EffectRenderer.applyEffectWrapper() during render().
    wrapper.onApplyObservable.add(() => {
        wrapper.effect.setFloat("uTime", currentTime);
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
