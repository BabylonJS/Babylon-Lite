// Shared textured-quad renderer — the common body of the text (ty 5) and image (ty 2) renderers,
// which are identical except for where their texture comes from. Both draw one premultiplied,
// alpha-blended quad per layer (a layer-local rect mapped through the layer's world matrix) using
// the same interleaved pos.xy / uv.xy / alpha layout, the same shader, and a growable vertex buffer.
//
// The caller supplies a TexturedQuadSource: the layer kind, how to find a layer's quad rect and
// texture, an optional extra readiness check (image decode is async), and texture teardown. Keeping
// the GL plumbing here means the text and image renderers are thin adapters over it — the two were
// ~85% identical before this split. (The buffer-growth logic here mirrors fill-renderer.ts's; keep
// the two in sync if you change it.)

import {
    type GLEngineContext,
    type GLEffect,
    type GLIndexBuffer,
    type GLTexture,
    type GLVertexBuffer,
    GLBlendMode,
    bindAttributes,
    createEffect,
    createIndexBuffer,
    createVertexBuffer,
    disposeBuffer,
    disposeEffect,
    drawIndexed,
    isEffectReady,
    setBlendMode,
    setColorMask,
    setCullState,
    setEffectFloat2,
    setEffectTexture,
    setStencilState,
    updateVertexBuffer,
    useEffect,
} from "@babylonjs/lite-gl";
import type { LayerRenderContext, LayerRenderer } from "./layer-renderer.js";
import type { ParsedLayer } from "../animation/parse.js";
import { apply, type Mat2D } from "../animation/matrix.js";

const FLOATS_PER_VERT = 5; // pos.xy, uv.xy, alpha
const VERTS_PER_QUAD = 6;

const QUAD_VERT = `#version 300 es
in vec2 position;
in vec2 uv;
in float alpha;
uniform vec2 uScreen;
out vec2 vUv;
out float vAlpha;
void main() {
  vUv = uv;
  vAlpha = alpha;
  gl_Position = vec4(position.x / uScreen.x * 2.0 - 1.0, 1.0 - position.y / uScreen.y * 2.0, 0.0, 1.0);
}`;

const QUAD_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in float vAlpha;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  // Source is straight alpha (Canvas2D text / decoded image); premultiply here for "over" compositing.
  vec4 c = texture(uTex, vUv);
  float a = c.a * vAlpha;
  fragColor = vec4(c.rgb * a, a);
}`;

/** The layer-local quad rect a {@link TexturedQuadSource} fills for a layer. */
export interface QuadRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** Per-variant hooks for {@link createTexturedQuadRenderer}. */
export interface TexturedQuadSource {
    /** Lottie layer `ty` this renderer handles (2 image, 5 text). */
    kind: number;
    /** Extra readiness beyond effect compilation (e.g. async image decode). */
    ready?: () => boolean;
    /** Fill `rect` with the layer's local quad; return `false` to skip the layer this frame. */
    fillRect(layer: ParsedLayer, rect: QuadRect): boolean;
    /** The texture to bind for a layer at record time, or `null` to skip. */
    textureFor(layer: ParsedLayer): GLTexture | null;
    /** Dispose the renderer-owned textures. */
    disposeTextures(): void;
}

// Interleaved attribute layout for the pos.xy / uv.xy / alpha vertex (shared, never mutated).
const QUAD_LAYOUT = [
    { name: "position", size: 2, offset: 0, divisor: 0 },
    { name: "uv", size: 2, offset: 8, divisor: 0 },
    { name: "alpha", size: 1, offset: 16, divisor: 0 },
];

/** Create a textured-quad renderer for one layer kind (text or image) from a variant source. */
export function createTexturedQuadRenderer(engine: GLEngineContext, source: TexturedQuadSource): LayerRenderer {
    const effect: GLEffect = createEffect(engine, {
        name: source.kind === 5 ? "lottie-vector-text" : "lottie-vector-image",
        vertexSource: QUAD_VERT,
        fragmentSource: QUAD_FRAG,
        uniformNames: ["uScreen"],
        samplerNames: ["uTex"],
        attributeNames: ["position", "uv", "alpha"],
    });

    const verts: number[] = [];
    const tokenLayer: ParsedLayer[] = [];
    const corner: [number, number] = [0, 0];
    const rect: QuadRect = { left: 0, top: 0, width: 0, height: 0 };

    let vbo: GLVertexBuffer | null = null;
    let vertData = new Float32Array(0);
    let vertCapacity = 0; // in floats
    let seqIb: GLIndexBuffer | null = null;
    let seqCapacity = 0; // in indices

    function pushVert(x: number, y: number, u: number, v: number, alpha: number): void {
        verts.push(x, y, u, v, alpha);
    }

    function ensureBuffers(quads: number): void {
        const neededFloats = Math.max(quads * VERTS_PER_QUAD * FLOATS_PER_VERT, FLOATS_PER_VERT);
        if (!vbo || vertCapacity < neededFloats) {
            if (vbo) {
                disposeBuffer(engine, vbo);
            }
            vertCapacity = Math.max(neededFloats, Math.ceil((vertCapacity || 1024) * 1.5));
            vertData = new Float32Array(vertCapacity);
            vbo = createVertexBuffer(engine, vertData, true);
        }
        const neededIdx = Math.max(quads * VERTS_PER_QUAD, VERTS_PER_QUAD);
        if (!seqIb || seqCapacity < neededIdx) {
            if (seqIb) {
                disposeBuffer(engine, seqIb);
            }
            seqCapacity = Math.max(neededIdx, Math.ceil((seqCapacity || 1024) * 1.5));
            const seq = new Uint32Array(seqCapacity);
            for (let i = 0; i < seqCapacity; i++) {
                seq[i] = i;
            }
            seqIb = createIndexBuffer(engine, seq);
        }
    }

    return {
        kind: source.kind,
        isReady: () => isEffectReady(engine, effect) && (source.ready ? source.ready() : true),
        beginFrame() {
            verts.length = 0;
            tokenLayer.length = 0;
        },
        emitLayer(layer: ParsedLayer, world: Mat2D, layerAlpha: number): number {
            if (layerAlpha <= 0.0001 || !source.fillRect(layer, rect)) {
                return -1;
            }
            const l = rect.left;
            const tp = rect.top;
            const rr = l + rect.width;
            const b = tp + rect.height;
            apply(world, l, tp, corner);
            const ax = corner[0];
            const ay = corner[1];
            apply(world, rr, tp, corner);
            const bx = corner[0];
            const by = corner[1];
            apply(world, rr, b, corner);
            const cx = corner[0];
            const cy = corner[1];
            apply(world, l, b, corner);
            const dx = corner[0];
            const dy = corner[1];
            pushVert(ax, ay, 0, 0, layerAlpha);
            pushVert(bx, by, 1, 0, layerAlpha);
            pushVert(cx, cy, 1, 1, layerAlpha);
            pushVert(ax, ay, 0, 0, layerAlpha);
            pushVert(cx, cy, 1, 1, layerAlpha);
            pushVert(dx, dy, 0, 1, layerAlpha);
            const token = tokenLayer.length;
            tokenLayer.push(layer);
            return token;
        },
        flush(ctx: LayerRenderContext) {
            const quads = tokenLayer.length;
            ensureBuffers(Math.max(quads, 1));
            if (quads > 0 && vbo) {
                vertData.set(verts);
                updateVertexBuffer(engine, vbo, vertData.subarray(0, verts.length));
            }
            useEffect(engine, effect);
            setEffectFloat2(engine, effect, "uScreen", ctx.screenW, ctx.screenH);
        },
        recordLayer(token: number) {
            const tex = source.textureFor(tokenLayer[token]);
            if (!tex || !vbo || !seqIb || !isEffectReady(engine, effect)) {
                return;
            }
            useEffect(engine, effect);
            // (Re)bind the interleaved layout on the shared default VAO — the fill renderer may have
            // bound its own single-attribute layout between quads (z-order interleaving).
            bindAttributes(engine, vbo, QUAD_LAYOUT, effect, true);
            // Textured quad: no stencil, no cull, premultiplied "over".
            setColorMask(engine, true, true, true, true);
            setCullState(engine, false);
            setStencilState(engine, { test: false });
            setBlendMode(engine, GLBlendMode.PREMULTIPLIED);
            setEffectTexture(engine, effect, "uTex", tex);
            drawIndexed(engine, seqIb, VERTS_PER_QUAD, token * VERTS_PER_QUAD);
        },
        dispose() {
            if (vbo) {
                disposeBuffer(engine, vbo);
                vbo = null;
            }
            if (seqIb) {
                disposeBuffer(engine, seqIb);
                seqIb = null;
            }
            source.disposeTextures();
            disposeEffect(engine, effect);
        },
    };
}
