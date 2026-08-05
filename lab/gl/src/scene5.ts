import {
    applyEffectWrapper,
    createEffectWrapper,
    createGLEngine,
    drawEffect,
    GLBlendMode,
    isEffectReady,
    resizeGLEngine,
    runRenderLoop,
    setBlendMode,
    setEffectFloat,
    setEffectFloat2,
    setEffectFloat3,
    setViewport,
    stopRenderLoop,
} from "babylon-lite-gl";

/**
 * Scene 5 — Blend Modes.
 *
 * Demonstrates `blend.ts` — `setBlendMode` + `GLBlendMode` — directly.
 *
 * Three clusters of heavily-overlapping soft discs are drawn with identical
 * geometry but different blend modes:
 *   - left:   `GLBlendMode.ADD`           — overlaps accumulate and bloom bright
 *   - centre: `GLBlendMode.ALPHA`         — standard non-premultiplied compositing
 *   - right:  `GLBlendMode.PREMULTIPLIED` — premultiplied source compositing
 *
 * Each disc is its own fullscreen-quad `drawEffect`, with `setBlendMode` called
 * once per cluster. Multiple draws are REQUIRED to show additive bloom: a single
 * fragment's output is clamped to `[0, 1]` on the RGBA8 backbuffer, so overlap
 * brightening only emerges by accumulating several draws into the framebuffer.
 * `PREMULTIPLIED` matches `ALPHA` here by design (that is the whole point of
 * premultiplied alpha — equivalent results for correctly-formatted source).
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
    mode: GLBlendMode;
    premultiply: number;
}

/** Aspect-corrected centred space: x in ~[-0.89, 0.89], y in [-0.5, 0.5]. */
const CLUSTERS: readonly BlendCluster[] = [
    { x: -0.55, y: 0, r: 1.0, g: 0.55, b: 0.15, mode: GLBlendMode.ADD, premultiply: 0 },
    { x: 0.0, y: 0, r: 0.2, g: 0.85, b: 1.0, mode: GLBlendMode.ALPHA, premultiply: 0 },
    { x: 0.55, y: 0, r: 1.0, g: 0.25, b: 0.85, mode: GLBlendMode.PREMULTIPLIED, premultiply: 1 },
];

const BACKGROUND_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
void main() {
    vec3 a = vec3(0.02, 0.02, 0.04);
    vec3 b = vec3(0.06, 0.07, 0.12);
    glFragColor = vec4(mix(a, b, vUv.y), 1.0);
}`;

const DISC_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uPremul;
void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vUv - 0.5;
    p.x *= aspect;
    float d = length(p - uCenter);
    float fall = smoothstep(0.16, 0.0, d);
    float a = fall * uAlpha;
    // uPremul = 1 premultiplies the colour for the PREMULTIPLIED blend func.
    vec3 rgb = mix(uColor, uColor * a, uPremul);
    glFragColor = vec4(rgb, a);
}`;

/**
 * Parse the parity harness's `?seekTime=<seconds>` query parameter.
 *
 * Returns the freeze time in seconds, or `null` when the parameter is absent or
 * not a finite number — in which case the scene animates on the wall clock. The
 * deterministic freeze is what makes a lite render directly comparable to the
 * Babylon.js reference (see tests/gl/parity and lab/gl/src/babylon-ref-scene5.ts).
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

const background = createEffectWrapper(engine, { name: "gl-scene5-bg", fragmentSource: BACKGROUND_FRAGMENT });
const bgEffect = background.effect;

const discs = createEffectWrapper(engine, {
    name: "gl-scene5-disc",
    fragmentSource: DISC_FRAGMENT,
    uniformNames: ["uResolution", "uCenter", "uColor", "uAlpha", "uPremul"],
});
const discEffect = discs.effect;

const seekTime = parseSeekTime();
const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, bgEffect) || !isEffectReady(engine, discEffect)) {
        return;
    }
    resizeGLEngine(engine);
    setViewport(engine);

    // Opaque background — blending explicitly disabled so it overwrites.
    applyEffectWrapper(background);
    setBlendMode(engine, GLBlendMode.DISABLE);
    drawEffect(engine);

    // Three clusters, one blend mode each. Frozen capture pins the disc-ring
    // animation clock to seekTime; otherwise advance on the wall clock.
    const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
    applyEffectWrapper(discs);
    setEffectFloat2(engine, discEffect, "uResolution", canvas.width, canvas.height);
    for (const cluster of CLUSTERS) {
        setEffectFloat3(engine, discEffect, "uColor", cluster.r, cluster.g, cluster.b);
        setEffectFloat(engine, discEffect, "uAlpha", DISC_ALPHA);
        setEffectFloat(engine, discEffect, "uPremul", cluster.premultiply);
        setBlendMode(engine, cluster.mode);
        for (let k = 0; k < DISCS_PER_CLUSTER; k++) {
            const angle = t * 0.5 + (k / DISCS_PER_CLUSTER) * TAU;
            const cx = cluster.x + RING_RADIUS * Math.cos(angle);
            const cy = cluster.y + RING_RADIUS * Math.sin(angle);
            setEffectFloat2(engine, discEffect, "uCenter", cx, cy);
            drawEffect(engine);
        }
    }

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        // 1 background + 3 clusters × 8 discs = 25 draws.
        canvas.dataset.drawCalls = "25";
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
