import {
    bindAttributes,
    clearEngine,
    createEffect,
    createGLEngine,
    createIndexBuffer,
    createVertexBuffer,
    drawIndexed,
    isEffectReady,
    resizeGLEngine,
    runRenderLoop,
    setColorMask,
    setCullState,
    setEffectFloat4,
    setStencilOpSeparate,
    setStencilState,
    setViewport,
    stopRenderLoop,
    useEffect,
} from "babylon-lite-gl";

/**
 * Scene 16 — Two-Sided Stencil.
 *
 * One indexed draw contains a CCW triangle on the left and a CW triangle on the
 * right. With culling disabled, the front triangle increments stencil from 0 to
 * 1 while the back triangle decrements it from 0 to 255. Two cover draws then
 * select those exact values and paint the triangles red and blue respectively.
 * A missing or incorrect face operation therefore removes the corresponding
 * triangle from the final image.
 */

const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 position;
void main() {
    gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform vec4 color;
out vec4 glFragColor;
void main() {
    glFragColor = color;
}`;

// Left triangle is CCW (front); right triangle is CW (back).
const VERTICES = new Float32Array([-0.9, -0.68, -0.1, -0.68, -0.5, 0.68, 0.1, -0.68, 0.5, 0.68, 0.9, -0.68]);
const INDICES = new Uint16Array([0, 1, 2, 3, 4, 5]);

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false, stencil: true });
const gl = engine.gl;
const effect = createEffect(engine, {
    name: "gl-scene16-two-sided-stencil",
    vertexSource: VERTEX_SOURCE,
    fragmentSource: FRAGMENT_SOURCE,
    uniformNames: ["color"],
    samplerNames: [],
    attributeNames: ["position"],
});
const vertexBuffer = createVertexBuffer(engine, VERTICES);
const indexBuffer = createIndexBuffer(engine, INDICES);
const freeze = new URLSearchParams(window.location.search).has("seekTime");
const initStart = performance.now();
let attributesBound = false;
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, effect)) {
        return;
    }
    if (!attributesBound) {
        bindAttributes(engine, vertexBuffer, [{ name: "position", size: 2, offset: 0, divisor: 0 }], effect);
        attributesBound = true;
    }

    resizeGLEngine(engine);
    setViewport(engine);
    useEffect(engine, effect);
    setCullState(engine, false);

    setColorMask(engine, true, true, true, true);
    setStencilState(engine, { test: true, mask: 0xff });
    clearEngine(engine, { color: { r: 0.027, g: 0.039, b: 0.059, a: 1 }, stencil: true });

    // One geometry draw applies different depth-pass operations by winding.
    setColorMask(engine, false, false, false, false);
    setStencilState(engine, {
        test: true,
        mask: 0xff,
        func: gl.ALWAYS,
        ref: 0,
        funcMask: 0xff,
        opFail: gl.KEEP,
        opZFail: gl.KEEP,
        opZPass: gl.KEEP,
    });
    setStencilOpSeparate(engine, gl.FRONT, { opZPass: gl.INCR_WRAP });
    setStencilOpSeparate(engine, gl.BACK, { opZPass: gl.DECR_WRAP });
    drawIndexed(engine, indexBuffer, INDICES.length, 0);

    // Front-facing coverage: stencil == 1.
    setColorMask(engine, true, true, true, true);
    setStencilState(engine, {
        test: true,
        mask: 0x00,
        func: gl.EQUAL,
        ref: 1,
        funcMask: 0xff,
        opFail: gl.KEEP,
        opZFail: gl.KEEP,
        opZPass: gl.KEEP,
    });
    setEffectFloat4(engine, effect, "color", 0.94, 0.24, 0.18, 1);
    drawIndexed(engine, indexBuffer, INDICES.length, 0);

    // Back-facing coverage: stencil == 255 after DECR_WRAP from zero.
    setStencilState(engine, { ref: 0xff });
    setEffectFloat4(engine, effect, "color", 0.13, 0.55, 0.96, 1);
    drawIndexed(engine, indexBuffer, INDICES.length, 0);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "3";
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (freeze) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
