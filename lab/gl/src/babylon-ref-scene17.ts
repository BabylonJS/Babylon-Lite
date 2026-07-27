import { Effect } from "@babylonjs/core/Materials/effect.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";

/** Babylon.js ThinEngine reference for GL Scene 17 — Alpha-to-Coverage. */

const QUAD = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
const INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
const RED: readonly [number, number, number] = [0.95, 0.12, 0.16];
const GREEN: readonly [number, number, number] = [0.1, 0.85, 0.32];
const ROWS = [
    { y: 0.85, redInFront: true, redRotation: -0.08, greenRotation: 0.1 },
    { y: -0.85, redInFront: false, redRotation: 0.1, greenRotation: -0.07 },
] as const;

const VERTEX_SHADER = `
attribute vec2 position;
uniform vec2 center;
uniform float angle;
uniform float depth;
void main(void) {
    float c = cos(angle);
    float s = sin(angle);
    vec2 local = position * 1.65;
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    vec2 world = center + rotated;
    gl_Position = vec4(world.x / 3.3, world.y / 2.2, depth, 1.0);
}`;
const FRAGMENT_SHADER = `
precision highp float;
uniform vec3 color;
uniform float opacity;
void main(void) {
    gl_FragColor = vec4(color, opacity);
}`;

function parseSeekTime(): number | null {
    const value = new URLSearchParams(window.location.search).get("seekTime");
    return value === null ? null : Number.parseFloat(value);
}

(function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new ThinEngine(canvas, true, { alpha: false, premultipliedAlpha: false, stencil: false }, false);
    const gl = engine._gl;
    const effect = new Effect({ vertexSource: VERTEX_SHADER, fragmentSource: FRAGMENT_SHADER }, ["position"], ["center", "angle", "depth", "color", "opacity"], [], engine, "");
    const vertices = engine.createVertexBuffer(QUAD);
    const indices = engine.createIndexBuffer(INDICES);
    const seekTime = parseSeekTime();
    let firstFrameDrawn = false;
    let alphaToCoverage = false;

    function setAlphaToCoverage(enabled: boolean): void {
        if (alphaToCoverage === enabled) {
            return;
        }
        alphaToCoverage = enabled;
        if (enabled) {
            gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        } else {
            gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        }
    }

    function drawCard(centerX: number, centerY: number, rotation: number, depth: number, color: readonly [number, number, number], opacity: number): void {
        effect.setFloat2("center", centerX, centerY);
        effect.setFloat("angle", rotation);
        effect.setFloat("depth", depth);
        effect.setFloat3("color", color[0], color[1], color[2]);
        effect.setFloat("opacity", opacity);
        engine.drawElementsType(0, 0, INDICES.length);
    }

    function drawPanel(x: number): void {
        for (const row of ROWS) {
            const redFront = row.redInFront;
            drawCard(x - 0.08, row.y - 0.04, row.redRotation, redFront ? 0.4 : 0.6, RED, redFront ? 0.5 : 1);
            drawCard(x + 0.08, row.y + 0.04, row.greenRotation, redFront ? 0.6 : 0.4, GREEN, redFront ? 1 : 0.5);
        }
    }

    engine.runRenderLoop(() => {
        if (!effect.isReady()) {
            return;
        }
        engine.resize();
        engine.setViewport({ x: 0, y: 0, width: 1, height: 1 });
        engine.depthCullingState.depthTest = true;
        engine.depthCullingState.depthMask = true;
        engine.depthCullingState.depthFunc = gl.LESS;
        engine.depthCullingState.cull = false;
        engine.clear(new Color4(0.035, 0.045, 0.07, 1), true, true);
        engine.enableEffect(effect);
        engine.bindBuffersDirectly(vertices, indices, [2], 8, effect);

        const sampleCount = Math.max(1, gl.getParameter(gl.SAMPLES) as number);
        setAlphaToCoverage(false);
        drawPanel(-1.65);
        setAlphaToCoverage(sampleCount > 1);
        drawPanel(1.65);
        setAlphaToCoverage(false);

        if (!firstFrameDrawn) {
            firstFrameDrawn = true;
            canvas.dataset.drawCalls = "8";
            canvas.dataset.sampleCount = String(sampleCount);
            canvas.dataset.initMs = String(performance.now() - initStart);
            canvas.dataset.ready = "true";
            if (seekTime !== null) {
                canvas.dataset.animationFrozen = "true";
                engine.stopRenderLoop();
            }
        }
    });
})();
