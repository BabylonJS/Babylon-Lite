import {
    clearEngine,
    createEffect,
    createGLEngine,
    createIndexBuffer,
    createMeshVao,
    createVertexBuffer,
    disableBlend,
    drawMesh,
    getCurrentSampleCount,
    isEffectReady,
    resizeGLEngine,
    runRenderLoop,
    setAlphaToCoverage,
    setCullState,
    setDepthState,
    setEffectFloat,
    setEffectFloat2,
    setEffectFloat3,
    setViewport,
    stopRenderLoop,
    useEffect,
} from "babylon-lite-gl";
import type { GLMeshVao } from "babylon-lite-gl";

/** Scene 17 — Alpha-to-Coverage, matching WebGPU Scene 268 and Babylon.js visual test #M4GBLK#0. */

const QUAD = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
const INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
const RED: readonly [number, number, number] = [0.95, 0.12, 0.16];
const GREEN: readonly [number, number, number] = [0.1, 0.85, 0.32];
// Rows sit far enough apart that no card ever overlaps a card from the other row. Cross-row overlap
// would land on identical depth values, and a depth tie resolves differently under reverse-Z
// "greater-equal" (WebGPU) than under strict LESS (WebGL2) — diverging the backends for reasons that
// have nothing to do with alpha-to-coverage.
const ROWS = [
    { y: 1.05, redInFront: true, redRotation: -0.08, greenRotation: 0.1 },
    { y: -1.05, redInFront: false, redRotation: 0.1, greenRotation: -0.07 },
] as const;

const VERTEX_SHADER = `#version 300 es
layout(location=0) in vec2 position;
uniform vec2 center;
uniform float angle;
uniform float depth;
void main(){float c=cos(angle);float s=sin(angle);vec2 local=position*1.65;vec2 rotated=vec2(local.x*c-local.y*s,local.x*s+local.y*c);vec2 world=center+rotated;gl_Position=vec4(world.x/3.3,world.y/2.2,depth,1.0);}`;
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec3 color;
uniform float opacity;
out vec4 glFragColor;
void main(){glFragColor=vec4(color,opacity);}`;

function parseSeekTime(): number | null {
    const value = new URLSearchParams(window.location.search).get("seekTime");
    return value === null ? null : Number.parseFloat(value);
}

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false, premultipliedAlpha: false, antialias: true, depth: true });
const gl = engine.gl;
const effect = createEffect(engine, {
    name: "gl-scene17-alpha-to-coverage",
    vertexSource: VERTEX_SHADER,
    fragmentSource: FRAGMENT_SHADER,
    attributeNames: ["position"],
    uniformNames: ["center", "angle", "depth", "color", "opacity"],
    samplerNames: [],
});
const vertices = createVertexBuffer(engine, QUAD);
const indices = createIndexBuffer(engine, INDICES);
const seekTime = parseSeekTime();
const initStart = performance.now();
let vao: GLMeshVao | null = null;
let firstFrameDrawn = false;

function drawCard(centerX: number, centerY: number, rotation: number, depth: number, color: readonly [number, number, number], opacity: number): void {
    setEffectFloat2(engine, effect, "center", centerX, centerY);
    setEffectFloat(engine, effect, "angle", rotation);
    setEffectFloat(engine, effect, "depth", depth);
    setEffectFloat3(engine, effect, "color", color[0], color[1], color[2]);
    setEffectFloat(engine, effect, "opacity", opacity);
    drawMesh(engine, vao!);
}

function drawPanel(x: number): void {
    for (const row of ROWS) {
        const redFront = row.redInFront;
        drawCard(x - 0.08, row.y - 0.04, row.redRotation, redFront ? 0.4 : 0.6, RED, redFront ? 0.5 : 1);
        drawCard(x + 0.08, row.y + 0.04, row.greenRotation, redFront ? 0.6 : 0.4, GREEN, redFront ? 1 : 0.5);
    }
}

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, effect)) {
        return;
    }
    if (vao === null) {
        vao = createMeshVao(engine, [{ buffer: vertices, attributes: [{ name: "position", size: 2, divisor: 0 }], computeStride: true }], indices, effect);
    }

    resizeGLEngine(engine);
    setViewport(engine);
    disableBlend(engine);
    setDepthState(engine, { test: true, write: true, func: gl.LESS });
    setCullState(engine, false);
    clearEngine(engine, { color: { r: 0.035, g: 0.045, b: 0.07, a: 1 }, depth: true });
    useEffect(engine, effect);

    const sampleCount = getCurrentSampleCount(engine);
    setAlphaToCoverage(engine, false);
    drawPanel(-1.65);
    setAlphaToCoverage(engine, sampleCount > 1);
    drawPanel(1.65);
    setAlphaToCoverage(engine, false);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "8";
        canvas.dataset.sampleCount = String(sampleCount);
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
