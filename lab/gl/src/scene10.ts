import { createGLEngine, createEffect, isEffectReady, resizeGLEngine, runRenderLoop, setViewport, stopRenderLoop, useEffect } from "babylon-lite-gl";
import { createIndexBuffer, createMeshVao, createVertexBuffer, drawMesh, type GLAttributeDescriptor, type GLMeshVao } from "babylon-lite-gl/mesh";
import { clearEngine, setCullState, setDepthState } from "babylon-lite-gl/depth-stencil";

/**
 * Scene 10 — Indexed Mesh + Instancing (the first lite-gl scene with REAL
 * geometry rather than a fullscreen quad).
 *
 * Exercises the @babylonjs/lite-gl/mesh sub-entry end-to-end, using the
 * VAO-cached static-mesh path:
 *   - `createVertexBuffer` uploads an interleaved (position + colour) base quad.
 *   - `createIndexBuffer` uploads the two-triangle index list.
 *   - `createMeshVao` records BOTH the per-vertex attributes (divisor 0) and the
 *     per-instance attributes (divisor 1, the default, from a second buffer) plus
 *     the index binding into ONE Vertex Array Object — once, after the effect
 *     compiles.
 *   - `drawMesh(…, INSTANCE_COUNT)` then binds the VAO and issues ONE
 *     `drawElementsInstanced` per frame that stamps the quad five times — with no
 *     per-frame `vertexAttribPointer`/`vertexAttribDivisor` and no
 *     `unbindInstanceAttributes` (the VAO isolates the divisors).
 *
 * Depth + cull (from @babylonjs/lite-gl/depth-stencil) are the visible proof
 * that depth-testing and instancing work: the five instances march diagonally
 * with a DECREASING clip-space z (0.50 → −0.30), so each upper-right instance
 * is nearer and OCCLUDES the lower-left ones. `setDepthState` enables the
 * depth test (LESS, write on) against a 1.0 depth clear; `setCullState` culls
 * back faces (the quad is wound CCW, front-facing toward the viewer).
 *
 * Determinism / convention-robustness:
 *   - Positions are authored DIRECTLY IN CLIP SPACE (w = 1), identical to the
 *     Babylon.js reference (lab/gl/src/babylon-ref-scene10.ts) — there is no
 *     camera / projection matrix whose handedness could differ between engines.
 *   - The diagonal layout is symmetric about screen centre; both engines use
 *     byte-identical clip-space coordinates, the same CCW winding, the same
 *     back-face cull and the same LESS depth test, so rasterisation matches
 *     pixel-for-pixel. Reverse-Z is NOT used: depth clears to 1.0, func LESS.
 *
 * The scene is static (no animation). `?seekTime=<seconds>` simply renders one
 * frame, stamps `dataset.animationFrozen` and halts — exactly like scene8.
 */

/** Half-extent of the base quad in clip space. */
const HALF = 0.3;

// Base quad: interleaved [pos.xyz, colour.rgb] × 4 vertices (stride 6 floats).
// z = 0 in the base mesh — the per-instance offset supplies the depth. The
// grayscale corner ramp makes the per-vertex colour interpolation visible; the
// per-instance tint multiplies it so each instance reads distinctly.
const QUAD_VERTICES = new Float32Array([
    // pos.x  pos.y  pos.z   col.r col.g col.b
    -HALF, -HALF, 0.0, 0.65, 0.65, 0.65, // 0 bottom-left
    HALF, -HALF, 0.0, 1.0, 1.0, 1.0, // 1 bottom-right
    HALF, HALF, 0.0, 0.85, 0.85, 0.85, // 2 top-right
    -HALF, HALF, 0.0, 0.55, 0.55, 0.55, // 3 top-left
]);

// Two triangles, wound counter-clockwise as seen from +z (the viewer) → the
// quad is front-facing under the GL-default CCW front face, so back-face
// culling keeps it.
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

// Per-instance: interleaved [offset.xyz, tint.rgb] × 5 (stride 6 floats).
// offset.z DECREASES as we step up-right, so later instances are nearer and
// occlude earlier ones under the LESS depth test.
const INSTANCES = new Float32Array([
    // offset.x offset.y offset.z   tint.r tint.g tint.b
    -0.36, -0.36, 0.5, 1.0, 0.35, 0.35, // far    — red
    -0.18, -0.18, 0.3, 1.0, 0.8, 0.3, // amber
    0.0, 0.0, 0.1, 0.45, 1.0, 0.5, // green
    0.18, 0.18, -0.1, 0.4, 0.7, 1.0, // blue
    0.36, 0.36, -0.3, 0.8, 0.45, 1.0, // near   — purple
]);

const INSTANCE_COUNT = 5;
/** Bytes from the start of one attribute element to the colour/tint half. */
const HALF_OFFSET_BYTES = 12;

// Vertex shader (GLSL ES 3.00): adds the per-instance offset to the clip-space
// position and multiplies the per-vertex colour by the per-instance tint. The
// Babylon.js reference computes the SAME two expressions in ES 1.00.
const VERTEX_SHADER = `#version 300 es
in vec3 a_pos;
in vec3 a_color;
in vec3 a_offset;
in vec3 a_tint;
out vec3 vColor;
void main() {
    vColor = a_color * a_tint;
    gl_Position = vec4(a_pos + a_offset, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 glFragColor;
void main() {
    glFragColor = vec4(vColor, 1.0);
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

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
// `depth: true` requests a depth buffer on the default framebuffer — lite-gl's
// engine defaults to NO depth buffer, but this scene needs the depth test.
const engine = createGLEngine(canvas, { alpha: false, depth: true });
const gl = engine.gl;

const effect = createEffect(engine, {
    name: "gl-scene10-mesh",
    vertexSource: VERTEX_SHADER,
    fragmentSource: FRAGMENT_SHADER,
    uniformNames: [],
    samplerNames: [],
    // The first attribute is bound to location 0; the rest resolve by name.
    attributeNames: ["a_pos", "a_color", "a_offset", "a_tint"],
});

// Static GPU buffers: the base quad, its indices, and the per-instance data.
const meshBuffer = createVertexBuffer(engine, QUAD_VERTICES);
const indexBuffer = createIndexBuffer(engine, QUAD_INDICES);
const instanceBuffer = createVertexBuffer(engine, INSTANCES);

// Per-vertex attributes (divisor 0 — advance every vertex). computeStride=true
// → stride = (3 + 3) · 4 = 24 bytes; colour starts 12 bytes in.
const BASE_ATTRIBUTES: readonly GLAttributeDescriptor[] = [
    { name: "a_pos", size: 3, offset: 0, divisor: 0 },
    { name: "a_color", size: 3, offset: HALF_OFFSET_BYTES, divisor: 0 },
];
// Per-instance attributes (divisor defaults to 1 — advance every instance).
const INSTANCE_ATTRIBUTES: readonly GLAttributeDescriptor[] = [
    { name: "a_offset", size: 3, offset: 0 },
    { name: "a_tint", size: 3, offset: HALF_OFFSET_BYTES },
];

const seekTime = parseSeekTime();
const initStart = performance.now();
let firstFrameDrawn = false;
/** Recorded once on the first ready frame (the effect's attribute locations must
 *  resolve first), then bound + drawn each frame. */
let meshVao: GLMeshVao | null = null;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, effect)) {
        return;
    }
    // Record the static mesh (both buffers' attribute layouts + the index binding)
    // into one VAO, once. The per-frame draw is then a single bind + draw.
    if (meshVao === null) {
        meshVao = createMeshVao(
            engine,
            [
                { buffer: meshBuffer, attributes: BASE_ATTRIBUTES, computeStride: true },
                { buffer: instanceBuffer, attributes: INSTANCE_ATTRIBUTES, computeStride: true },
            ],
            indexBuffer,
            effect
        );
    }
    resizeGLEngine(engine);
    setViewport(engine); // full canvas

    // Depth + cull state — the parity-critical pair. LESS against a 1.0 clear,
    // depth writes on; cull back faces (front face stays GL-default CCW).
    setDepthState(engine, { test: true, write: true, func: gl.LESS });
    setCullState(engine, true, gl.BACK);

    // Opaque black colour clear + depth clear (to the default 1.0).
    clearEngine(engine, { color: { r: 0, g: 0, b: 0, a: 1 }, depth: true });

    useEffect(engine, effect);

    // Bind the recorded VAO and draw all five instances in ONE call — no per-frame
    // vertexAttribPointer/Divisor, no unbindInstanceAttributes.
    drawMesh(engine, meshVao, INSTANCE_COUNT);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "1"; // one instanced draw of 5 quads
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
