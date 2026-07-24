import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { Effect } from "@babylonjs/core/Materials/effect.js";

/** Babylon.js reference for GL Scene 16 — Two-Sided Stencil. */

const VERTEX_SOURCE = `
attribute vec2 position;
void main(void) {
    gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `
precision highp float;
uniform vec4 color;
void main(void) {
    gl_FragColor = color;
}`;

const VERTICES = new Float32Array([-0.9, -0.68, -0.1, -0.68, -0.5, 0.68, 0.1, -0.68, 0.5, 0.68, 0.9, -0.68]);
const INDICES = new Uint16Array([0, 1, 2, 3, 4, 5]);

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new ThinEngine(canvas, false, { alpha: false, premultipliedAlpha: false, stencil: true }, false);
const gl = engine._gl;
const effect = new Effect({ vertexSource: VERTEX_SOURCE, fragmentSource: FRAGMENT_SOURCE }, ["position"], ["color"], [], engine, "");
const vertexBuffer = engine.createVertexBuffer(VERTICES);
const indexBuffer = engine.createIndexBuffer(INDICES);
const freeze = new URLSearchParams(window.location.search).has("seekTime");
const initStart = performance.now();
let firstFrameDrawn = false;

function setStencil(func: number, ref: number, mask: number, frontZPass: number, backZPass: number): void {
    const state = engine.stencilState;
    state.stencilTest = true;
    state.stencilMask = mask;
    state.stencilFunc = func;
    state.stencilBackFunc = func;
    state.stencilFuncRef = ref;
    state.stencilFuncMask = 0xff;
    state.stencilOpStencilFail = gl.KEEP;
    state.stencilOpDepthFail = gl.KEEP;
    state.stencilOpStencilDepthPass = frontZPass;
    state.stencilBackOpStencilFail = gl.KEEP;
    state.stencilBackOpDepthFail = gl.KEEP;
    state.stencilBackOpStencilDepthPass = backZPass;
}

engine.runRenderLoop(() => {
    if (!effect.isReady()) {
        return;
    }

    engine.resize();
    engine.setViewport({ x: 0, y: 0, width: 1, height: 1 });
    engine.depthCullingState.cull = false;
    engine.enableEffect(effect);
    engine.bindBuffersDirectly(vertexBuffer, indexBuffer, [2], 8, effect);

    engine.setColorWrite(true);
    setStencil(gl.ALWAYS, 0, 0xff, gl.KEEP, gl.KEEP);
    engine.clear({ r: 0.027, g: 0.039, b: 0.059, a: 1 }, true, false, true);

    engine.setColorWrite(false);
    setStencil(gl.ALWAYS, 0, 0xff, gl.INCR_WRAP, gl.DECR_WRAP);
    engine.drawElementsType(0, 0, INDICES.length);

    engine.setColorWrite(true);
    setStencil(gl.EQUAL, 1, 0x00, gl.KEEP, gl.KEEP);
    effect.setFloat4("color", 0.94, 0.24, 0.18, 1);
    engine.drawElementsType(0, 0, INDICES.length);

    setStencil(gl.EQUAL, 0xff, 0x00, gl.KEEP, gl.KEEP);
    effect.setFloat4("color", 0.13, 0.55, 0.96, 1);
    engine.drawElementsType(0, 0, INDICES.length);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "3";
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (freeze) {
            canvas.dataset.animationFrozen = "true";
            engine.stopRenderLoop();
        }
    }
});

window.addEventListener("resize", () => engine.resize());
