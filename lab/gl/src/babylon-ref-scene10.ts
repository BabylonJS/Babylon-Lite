import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { Effect } from "@babylonjs/core/Materials/effect.js";
import type { InstancingAttributeInfo } from "@babylonjs/core/Engines/instancingAttributeInfo.js";

/**
 * Babylon.js reference for GL Scene 10 — Indexed Mesh + Instancing.
 *
 * Reproduces lab/gl/src/scene10.ts (which uses @babylonjs/lite-gl/mesh's
 * createVertexBuffer / createIndexBuffer / bindAttributes / drawIndexed) with
 * Babylon's ThinEngine RAW geometry API, so the parity harness can diff the two
 * pixel-for-pixel:
 *   - `engine.createVertexBuffer` / `createDynamicVertexBuffer` /
 *     `createIndexBuffer` upload the SAME interleaved data buffers.
 *   - A raw `Effect` (inline `vertexSource` / `fragmentSource`, NO shader store)
 *     declares the same four attributes.
 *   - `engine.bindBuffersDirectly` binds the per-vertex (position + colour)
 *     attributes straight from the base DataBuffer; `updateAndBindInstancesBuffer`
 *     binds the per-instance (offset + tint) attributes with divisor 1 — the
 *     analogue of lite-gl's two `bindAttributes` calls.
 *   - `engine.drawElementsType(0, 0, 6, 5)` issues ONE `drawElementsInstanced`.
 *
 * Why this matches lite-gl exactly:
 *   - Positions are authored DIRECTLY IN CLIP SPACE (w = 1) — byte-identical to
 *     scene10 — so there is no camera / projection convention to mismatch.
 *   - Same CCW winding, same back-face cull, same LESS depth test against a 1.0
 *     depth clear (reverse-Z is NOT used). The depth/cull state is set straight
 *     on `engine.depthCullingState` (NOT via `setState`, which would also touch
 *     the front-face winding) so the front face stays GL-default CCW, exactly
 *     like lite-gl.
 *   - Fragments are the SAME expressions as scene10 in ES 1.00 form (attribute /
 *     varying / gl_Position / gl_FragColor); Babylon's WebGL2 processor converts
 *     them to ES 3.00 without changing the math.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE frame (the scene is
 * static) then stamps dataset.animationFrozen="true" and stops the loop.
 */

const HALF = 0.3;

// Base quad: interleaved [pos.xyz, colour.rgb] × 4 (stride 6 floats) — identical
// to scene10's QUAD_VERTICES.
const QUAD_VERTICES = new Float32Array([
    -HALF, -HALF, 0.0, 0.65, 0.65, 0.65, // 0 bottom-left
    HALF, -HALF, 0.0, 1.0, 1.0, 1.0, // 1 bottom-right
    HALF, HALF, 0.0, 0.85, 0.85, 0.85, // 2 top-right
    -HALF, HALF, 0.0, 0.55, 0.55, 0.55, // 3 top-left
]);

// CCW as seen from +z → front-facing under the GL-default CCW front face.
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

// Per-instance: interleaved [offset.xyz, tint.rgb] × 5 (stride 6 floats) —
// identical to scene10's INSTANCES. offset.z decreases up-right so nearer
// instances occlude farther ones under LESS.
const INSTANCES = new Float32Array([
    -0.36, -0.36, 0.5, 1.0, 0.35, 0.35, // far    — red
    -0.18, -0.18, 0.3, 1.0, 0.8, 0.3, // amber
    0.0, 0.0, 0.1, 0.45, 1.0, 0.5, // green
    0.18, 0.18, -0.1, 0.4, 0.7, 1.0, // blue
    0.36, 0.36, -0.3, 0.8, 0.45, 1.0, // near   — purple
]);

const INSTANCE_COUNT = 5;
const INDEX_COUNT = 6;
/** Stride (bytes) of one interleaved vertex / instance: (3 + 3) · 4. */
const STRIDE_BYTES = 24;
/** Byte offset of the colour / tint half within a stride. */
const HALF_OFFSET_BYTES = 12;

const VERTEX_SHADER = `
attribute vec3 a_pos;
attribute vec3 a_color;
attribute vec3 a_offset;
attribute vec3 a_tint;
varying vec3 vColor;
void main(void) {
    vColor = a_color * a_tint;
    gl_Position = vec4(a_pos + a_offset, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec3 vColor;
void main(void) {
    gl_FragColor = vec4(vColor, 1.0);
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

    // Same construction as the other GL references (antialias off, opaque, no
    // device-ratio adaptation). ThinEngine requests a depth buffer by default,
    // which the depth test needs.
    const engine = new ThinEngine(canvas, false, { alpha: false, premultipliedAlpha: false, stencil: false }, false);
    const gl = engine._gl;

    const effect = new Effect(
        { vertexSource: VERTEX_SHADER, fragmentSource: FRAGMENT_SHADER },
        ["a_pos", "a_color", "a_offset", "a_tint"],
        [],
        [],
        engine,
        ""
    );

    // Raw DataBuffers — the analogue of lite-gl's GLVertexBuffer / GLIndexBuffer.
    const meshBuffer = engine.createVertexBuffer(QUAD_VERTICES);
    const indexBuffer = engine.createIndexBuffer(QUAD_INDICES);
    const instanceBuffer = engine.createDynamicVertexBuffer(INSTANCES);

    // Resolved lazily once the effect links (attribute locations need the
    // program). Pre-setting `index` routes updateAndBindInstancesBuffer to the
    // generic (computeStride) attribute path rather than the matrix fast-path.
    let offsetLocations: InstancingAttributeInfo[] | null = null;

    const seekTime = parseSeekTime();
    let firstFrameDrawn = false;

    engine.runRenderLoop(() => {
        if (!effect.isReady()) {
            return;
        }
        engine.resize();
        engine.setViewport({ x: 0, y: 0, width: 1, height: 1 }); // full canvas

        // Depth + cull state, mirroring lite-gl's setDepthState / setCullState.
        // Set directly on depthCullingState so the front face is left at the
        // GL-default CCW (setState would force a winding).
        engine.depthCullingState.depthTest = true;
        engine.depthCullingState.depthMask = true;
        engine.depthCullingState.depthFunc = gl.LESS;
        engine.depthCullingState.cull = true;
        engine.depthCullingState.cullFace = gl.BACK;

        // Opaque black + depth clear (clear() sets clearDepth(1.0) for the
        // forward depth buffer).
        engine.clear({ r: 0, g: 0, b: 0, a: 1 }, true, true);

        engine.enableEffect(effect);

        if (offsetLocations === null) {
            offsetLocations = [
                { attributeName: "a_offset", index: effect.getAttributeLocationByName("a_offset"), attributeSize: 3, offset: 0, divisor: 1 },
                { attributeName: "a_tint", index: effect.getAttributeLocationByName("a_tint"), attributeSize: 3, offset: HALF_OFFSET_BYTES, divisor: 1 },
            ];
        }

        // Per-vertex attributes (position + colour) straight from the base
        // DataBuffer, then the per-instance attributes, then one instanced draw.
        engine.bindBuffersDirectly(meshBuffer, indexBuffer, [3, 3], STRIDE_BYTES, effect);
        engine.updateAndBindInstancesBuffer(instanceBuffer, INSTANCES, offsetLocations);
        engine.drawElementsType(0, 0, INDEX_COUNT, INSTANCE_COUNT);
        engine.unbindInstanceAttributes();

        if (!firstFrameDrawn) {
            firstFrameDrawn = true;
            canvas.dataset.drawCalls = "1";
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
