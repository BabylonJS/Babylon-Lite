import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
// Side-effect import: per-cluster blending uses engine.setAlphaMode, which lives
// in the engine.alpha extension (ThinEngine.prototype.setAlphaMode).
import "@babylonjs/core/Engines/Extensions/engine.alpha.js";

/**
 * Babylon.js reference for GL Scene 5 — Blend Modes.
 *
 * Reproduces lab/gl/src/scene5.ts (which drives @babylonjs/lite-gl's
 * `setBlendMode` + `GLBlendMode` directly) with Babylon's ThinEngine +
 * EffectRenderer + `engine.setAlphaMode`, so the parity harness can diff the two
 * pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - Geometry / UV / context / size: identical to the scene1 reference (default
 *    EffectRenderer fullscreen quad, postprocess vUV, opaque buffer, hwScaling=1).
 *  - Fragments: the SAME background + disc expressions as scene5, in ES1.00 form
 *    (varying / gl_FragColor). Babylon auto-converts to ES3.00.
 *  - Blend modes: lite-gl's `GLBlendMode.ADD/ALPHA/PREMULTIPLIED` (1 / 2 / 7) are
 *    Babylon's `Constants.ALPHA_ADD/ALPHA_COMBINE/ALPHA_PREMULTIPLIED`, and
 *    lite-gl's `setBlendMode` copies Babylon's `setAlphaMode` blendFuncSeparate
 *    params verbatim: ADD=(SRC_ALPHA,ONE,ZERO,ONE), COMBINE=(SRC_ALPHA,
 *    ONE_MINUS_SRC_ALPHA,ONE,ONE), PREMULTIPLIED=(ONE,ONE_MINUS_SRC_ALPHA,ONE,
 *    ONE), all with FUNC_ADD. Calling `engine.setAlphaMode(mode)` before each
 *    `EffectRenderer.render` works because render() only saves/restores
 *    depth+stencil — it never touches the alpha state — so the mode persists
 *    through the draw, exactly like lite-gl's `setBlendMode` + `drawEffect`.
 *  - Draw order: opaque background first (alpha DISABLE), then 3 clusters × 8
 *    discs, one blend mode per cluster — accumulating overlaps into the RGBA8
 *    backbuffer, identical to scene5 (25 draws total).
 *
 * Determinism: ?seekTime=<seconds> animates the disc rings at t=seekTime, renders
 * exactly ONE frame, then stamps dataset.animationFrozen="true" and stops.
 */

const TAU = Math.PI * 2;
const DISCS_PER_CLUSTER = 8;
const RING_RADIUS = 0.1;
const DISC_ALPHA = 0.65;

interface BlendCluster {
    x: number;
    y: number;
    r: number;
    g: number;
    b: number;
    mode: number;
    premultiply: number;
}

/** Identical clusters to scene5, with lite GLBlendMode mapped to the equal-valued
 *  Babylon Constants.ALPHA_* (ADD=1, COMBINE=2, PREMULTIPLIED=7). */
const CLUSTERS: readonly BlendCluster[] = [
    { x: -0.55, y: 0, r: 1.0, g: 0.55, b: 0.15, mode: Constants.ALPHA_ADD, premultiply: 0 },
    { x: 0.0, y: 0, r: 0.2, g: 0.85, b: 1.0, mode: Constants.ALPHA_COMBINE, premultiply: 0 },
    { x: 0.55, y: 0, r: 1.0, g: 0.25, b: 0.85, mode: Constants.ALPHA_PREMULTIPLIED, premultiply: 1 },
];

// ES1.00 form of scene5's BACKGROUND_FRAGMENT.
const BACKGROUND_FRAGMENT = `
precision highp float;
varying vec2 vUV;
void main(void) {
    vec3 a = vec3(0.02, 0.02, 0.04);
    vec3 b = vec3(0.06, 0.07, 0.12);
    gl_FragColor = vec4(mix(a, b, vUV.y), 1.0);
}`;

// ES1.00 form of scene5's DISC_FRAGMENT.
const DISC_FRAGMENT = `
precision highp float;
varying vec2 vUV;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uPremul;
void main(void) {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vUV - 0.5;
    p.x *= aspect;
    float d = length(p - uCenter);
    float fall = smoothstep(0.16, 0.0, d);
    float a = fall * uAlpha;
    // uPremul = 1 premultiplies the colour for the PREMULTIPLIED blend func.
    vec3 rgb = mix(uColor, uColor * a, uPremul);
    gl_FragColor = vec4(rgb, a);
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

    const renderer = new EffectRenderer(engine);
    const background = new EffectWrapper({
        engine,
        name: "gl-scene5-bg-ref",
        fragmentShader: BACKGROUND_FRAGMENT,
        useShaderStore: false,
    });
    const discs = new EffectWrapper({
        engine,
        name: "gl-scene5-disc-ref",
        fragmentShader: DISC_FRAGMENT,
        uniforms: ["uResolution", "uCenter", "uColor", "uAlpha", "uPremul"],
        useShaderStore: false,
    });

    // Per-disc state read by onApply (the disc effect is bound during each
    // EffectRenderer.render → applyEffectWrapper → onApply notification).
    let curCx = 0;
    let curCy = 0;
    let curR = 0;
    let curG = 0;
    let curB = 0;
    let curPremul = 0;
    discs.onApplyObservable.add(() => {
        const e = discs.effect;
        e.setFloat2("uResolution", canvas.width, canvas.height);
        e.setFloat2("uCenter", curCx, curCy);
        e.setFloat3("uColor", curR, curG, curB);
        e.setFloat("uAlpha", DISC_ALPHA);
        e.setFloat("uPremul", curPremul);
    });

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let firstFrameDrawn = false;

    engine.runRenderLoop(() => {
        if (!background.effect.isReady() || !discs.effect.isReady()) {
            return;
        }
        engine.resize();
        const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;

        // Opaque background — blending explicitly disabled so it overwrites.
        engine.setAlphaMode(Constants.ALPHA_DISABLE);
        renderer.render(background);

        // Three clusters, one blend mode each (set before the draws; persists
        // through EffectRenderer.render, which never touches the alpha state).
        for (const cluster of CLUSTERS) {
            curR = cluster.r;
            curG = cluster.g;
            curB = cluster.b;
            curPremul = cluster.premultiply;
            engine.setAlphaMode(cluster.mode);
            for (let k = 0; k < DISCS_PER_CLUSTER; k++) {
                const angle = t * 0.5 + (k / DISCS_PER_CLUSTER) * TAU;
                curCx = cluster.x + RING_RADIUS * Math.cos(angle);
                curCy = cluster.y + RING_RADIUS * Math.sin(angle);
                renderer.render(discs);
            }
        }

        if (!firstFrameDrawn) {
            firstFrameDrawn = true;
            canvas.dataset.drawCalls = "25";
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
