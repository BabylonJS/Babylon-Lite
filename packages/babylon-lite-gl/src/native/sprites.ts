/**
 * Native sprite renderer — the native-backend twin of `sprites.ts`. The public
 * API (createSpriteRenderer / renderSprites / setSpriteRendererTexture /
 * disposeSpriteRenderer) and the allocation-free per-sprite vertex math are
 * IDENTICAL to the WebGL module (copied verbatim so both backends render the same
 * geometry); only the GPU upload/bind/draw path uses the native command stream.
 */
import { offContextRestored, onContextRestored, type GLEngineContext } from "./native-context.js";
import { createEffect, disposeEffect, isEffectReady, type GLEffect, setEffectMatrix, setEffectTexture, useEffect } from "./effect.js";
import { GLBlendMode, setBlendMode } from "./blend.js";
import { applyNativeStates } from "./native-apply-states.js";
import type { GLTexture } from "./texture.js";
import {
    dBindVertexArray,
    dCreateIndexBuffer,
    dCreateVertexArray,
    dCreateVertexBuffer,
    dDeleteIndexBuffer,
    dDeleteVertexArray,
    dDeleteVertexBuffer,
    dDrawIndexed,
    dRecordIndexBuffer,
    dRecordVertexBuffer,
    dUpdateVertexBuffer,
} from "./native-device.js";

/* ─────────────────────────────  shaders (GLSL ES 3.00)  ───────────────────── */

/** Vertex shader — GLSL ES 3.00, attribute locations 0..5 (matches the WebGL module). */
const SPRITE_VERTEX_SOURCE = `#version 300 es
precision highp float;
layout(location = 0) in vec4 position;
layout(location = 1) in vec2 options;
layout(location = 2) in vec2 offsets;
layout(location = 3) in vec2 inverts;
layout(location = 4) in vec4 cellInfo;
layout(location = 5) in vec4 color;
uniform mat4 view;
uniform mat4 projection;
out vec2 vUV;
out vec4 vColor;
void main(void) {
    vec3 viewPos = (view * vec4(position.xyz, 1.0)).xyz;
    float angle = position.w;
    vec2 size = vec2(options.x, options.y);
    vec2 offset = offsets.xy;
    vec2 cornerPos = vec2(offset.x - 0.5, offset.y - 0.5) * size;
    vec3 rotatedCorner;
    rotatedCorner.x = cornerPos.x * cos(angle) - cornerPos.y * sin(angle);
    rotatedCorner.y = cornerPos.x * sin(angle) + cornerPos.y * cos(angle);
    rotatedCorner.z = 0.0;
    viewPos += rotatedCorner;
    gl_Position = projection * vec4(viewPos, 1.0);
    vColor = color;
    vec2 uvOffset = vec2(abs(offset.x - inverts.x), abs(1.0 - offset.y - inverts.y));
    vec2 uvPlace = cellInfo.xy;
    vec2 uvSize = cellInfo.zw;
    vUV.x = uvPlace.x + uvSize.x * uvOffset.x;
    vUV.y = uvPlace.y + uvSize.y * uvOffset.y;
}`;

/** Fragment shader — GLSL ES 3.00 (matches the WebGL module). */
const SPRITE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D diffuseSampler;
out vec4 glFragColor;
void main(void) {
    vec4 color = texture(diffuseSampler, vUV);
    color *= vColor;
    glFragColor = color;
}`;

/* ─────────────────────────────  layout constants  ─────────────────────────── */

const FLOATS_PER_VERTEX = 18;
const VERTS_PER_SPRITE = 4;
const INDICES_PER_SPRITE = 6;
const BYTES_PER_FLOAT = 4;
const VERTEX_STRIDE_BYTES = FLOATS_PER_VERTEX * BYTES_PER_FLOAT;
const SPRITE_EPSILON = 0.01;
const MAX_CAPACITY = 16384;
const CORNER_OFFSET_X = [0, 1, 1, 0];
const CORNER_OFFSET_Y = [0, 0, 1, 1];
const SPRITE_ATTRIBUTES = ["position", "options", "offsets", "inverts", "cellInfo", "color"] as const;

/* ───────────────────────────────  public types  ──────────────────────────── */

/** An RGBA color, each channel 0..1. */
export interface GLSpriteColor {
    /** Red 0..1. */
    r: number;
    /** Green 0..1. */
    g: number;
    /** Blue 0..1. */
    b: number;
    /** Alpha 0..1. */
    a: number;
}

/** A single sprite — same shape as the WebGL `GLSprite`. */
export interface GLSprite {
    /** World-space center. */
    position: { x: number; y: number; z: number };
    /** Width in world units. */
    width: number;
    /** Height in world units. */
    height: number;
    /** Rotation angle in radians. */
    angle: number;
    /** Sprite-sheet cell index (row-major). Default 0. */
    cellIndex?: number;
    /** Tint; default opaque white. */
    color?: GLSpriteColor;
    /** Flip the cell horizontally. */
    invertU?: boolean;
    /** Flip the cell vertically. */
    invertV?: boolean;
    /** Manual UV rect left (normalized). */
    uOffset?: number;
    /** Manual UV rect top (normalized). */
    vOffset?: number;
    /** Manual UV rect width (texels) — presence switches to manual-UV mode. */
    uSize?: number;
    /** Manual UV rect height (texels). */
    vSize?: number;
    /** When false, the sprite is skipped. Default true. */
    isVisible?: boolean;
}

/** Options for {@link createSpriteRenderer} — same shape as the WebGL module. */
export interface GLSpriteRendererOptions {
    /** Max sprites per draw (1..16384). */
    capacity: number;
    /** Cell width in texels (fixed-grid path). Default 1. */
    cellWidth?: number;
    /** Cell height in texels. Default 1. */
    cellHeight?: number;
    /** Per-corner UV/position inset. Default 0.01. */
    epsilon?: number;
    /** The sprite-sheet texture. */
    texture: GLTexture;
    /** Blend mode. Default {@link GLBlendMode.ALPHA}. */
    blendMode?: GLBlendMode;
    /** Reset blend to DISABLE after drawing. Default true. */
    autoResetAlpha?: boolean;
    /** Babylon-parity flag (no effect without a depth attachment). */
    disableDepthWrite?: boolean;
}

/** A native sprite renderer owning its VBO/IBO/VAO and effect. */
export interface GLSpriteRenderer {
    /** The sprite-sheet texture. */
    texture: GLTexture;
    /** Cell width in texels. */
    cellWidth: number;
    /** Cell height in texels. */
    cellHeight: number;
    /** Per-corner inset. */
    epsilon: number;
    /** Active blend mode. */
    blendMode: GLBlendMode;
    /** Reset blend after drawing. */
    autoResetAlpha: boolean;
    /** Babylon-parity flag. */
    disableDepthWrite: boolean;
    /** Max sprites per draw. */
    readonly capacity: number;
    /** @internal The compiled sprite effect this renderer owns (its `_engine`
     *  is the renderer's engine). */
    _effect: GLEffect;
    /** @internal Native sprite VAO. */
    _vao: import("./native-types.js").NativeData | null;
    /** @internal Dynamic native vertex buffer. */
    _vbo: import("./native-types.js").NativeData | null;
    /** @internal Static native index buffer. */
    _ibo: import("./native-types.js").NativeData | null;
    /** @internal Preallocated CPU vertex scratch. */
    _vertexData: Float32Array;
    /** @internal Preallocated index data. */
    _indices: Uint16Array;
    /** @internal Device-restore handler. */
    _restore: () => void;
    /** @internal */
    _disposed: boolean;
}

/* ────────────────────────────────  public API  ───────────────────────────── */

/**
 * Create a sprite renderer with its own native buffers + effect. Preallocates the
 * CPU scratch and index buffer so {@link renderSprites} performs no allocations.
 * Mirrors the WebGL `createSpriteRenderer`.
 */
export function createSpriteRenderer(engine: GLEngineContext, options: GLSpriteRendererOptions): GLSpriteRenderer {
    const capacity = options.capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
        throw new Error(`lite-gl: sprite renderer capacity must be an integer in [1, ${MAX_CAPACITY}], got ${capacity}`);
    }
    const cellWidth = options.cellWidth ?? 1;
    const cellHeight = options.cellHeight ?? 1;
    if (!(cellWidth > 0) || !(cellHeight > 0)) {
        throw new Error("lite-gl: sprite renderer cellWidth/cellHeight must be > 0");
    }

    const effect = createEffect(engine, {
        name: "sprites",
        vertexSource: SPRITE_VERTEX_SOURCE,
        fragmentSource: SPRITE_FRAGMENT_SOURCE,
        uniformNames: ["view", "projection"],
        samplerNames: ["diffuseSampler"],
        attributeNames: SPRITE_ATTRIBUTES,
    });

    const indices = new Uint16Array(capacity * INDICES_PER_SPRITE);
    for (let i = 0; i < capacity; i++) {
        const v = i * VERTS_PER_SPRITE;
        const o = i * INDICES_PER_SPRITE;
        indices[o] = v;
        indices[o + 1] = v + 1;
        indices[o + 2] = v + 2;
        indices[o + 3] = v;
        indices[o + 4] = v + 2;
        indices[o + 5] = v + 3;
    }

    const renderer: GLSpriteRenderer = {
        texture: options.texture,
        cellWidth,
        cellHeight,
        epsilon: options.epsilon ?? SPRITE_EPSILON,
        blendMode: options.blendMode ?? GLBlendMode.ALPHA,
        autoResetAlpha: options.autoResetAlpha ?? true,
        disableDepthWrite: options.disableDepthWrite ?? false,
        capacity,
        _effect: effect,
        _vao: null,
        _vbo: null,
        _ibo: null,
        _vertexData: new Float32Array(capacity * VERTS_PER_SPRITE * FLOATS_PER_VERTEX),
        _indices: indices,
        _restore: () => {},
        _disposed: false,
    };

    renderer._restore = (): void => {
        buildSpriteBuffers(renderer);
    };
    onContextRestored(engine, renderer._restore);
    buildSpriteBuffers(renderer);
    return renderer;
}

/**
 * Build the per-sprite vertex data and draw all visible sprites in one indexed
 * native draw. Allocation-free. Mirrors the WebGL `renderSprites` exactly for the
 * CPU vertex build; the upload/bind/draw uses the native command stream.
 */
export function renderSprites(
    renderer: GLSpriteRenderer,
    sprites: readonly GLSprite[],
    deltaTime: number,
    viewMatrix: Float32Array | number[],
    projectionMatrix: Float32Array | number[]
): void {
    const engine = renderer._effect._engine;
    if (engine._isLost || engine._disposed || renderer._disposed) {
        return;
    }
    void deltaTime;
    const tex = renderer.texture;
    if (!tex.isReady || sprites.length === 0) {
        return;
    }
    const effect = renderer._effect;
    if (!isEffectReady(effect)) {
        return;
    }
    if (renderer._vao === null || renderer._vbo === null) {
        return;
    }

    // ── Build vertex data (allocation-free, copied verbatim from the WebGL module) ──
    const vd = renderer._vertexData;
    const eps = renderer.epsilon;
    const texW = tex.width;
    const texH = tex.height;
    const cellW = renderer.cellWidth;
    const cellH = renderer.cellHeight;
    const rowSize = texW / cellW;
    const cellWidthN = cellW / texW;
    const cellHeightN = cellH / texH;
    const cap = renderer.capacity;
    const count = sprites.length;
    let visible = 0;
    for (let i = 0; i < count && visible < cap; i++) {
        const sprite = sprites[i];
        if (sprite === undefined || sprite.isVisible === false) {
            continue;
        }
        let cellLeft: number;
        let cellTop: number;
        let cellWN: number;
        let cellHN: number;
        if (sprite.uSize !== undefined) {
            cellLeft = sprite.uOffset ?? 0;
            cellTop = sprite.vOffset ?? 0;
            cellWN = sprite.uSize / texW;
            cellHN = (sprite.vSize ?? 0) / texH;
        } else {
            const cellIndex = (sprite.cellIndex ?? 0) > 0 ? (sprite.cellIndex as number) : 0;
            const row = (cellIndex / rowSize) >> 0;
            cellLeft = ((cellIndex - row * rowSize) * cellW) / texW;
            cellTop = (row * cellH) / texH;
            cellWN = cellWidthN;
            cellHN = cellHeightN;
        }

        const px = sprite.position.x;
        const py = sprite.position.y;
        const pz = sprite.position.z;
        const angle = sprite.angle;
        const w = sprite.width;
        const h = sprite.height;
        const invU = sprite.invertU === true ? 1 : 0;
        const invV = sprite.invertV === true ? 1 : 0;
        const color = sprite.color;
        const cr = color !== undefined ? color.r : 1;
        const cg = color !== undefined ? color.g : 1;
        const cb = color !== undefined ? color.b : 1;
        const ca = color !== undefined ? color.a : 1;

        let off = visible * VERTS_PER_SPRITE * FLOATS_PER_VERTEX;
        for (let c = 0; c < VERTS_PER_SPRITE; c++) {
            const ox = CORNER_OFFSET_X[c] === 0 ? eps : 1 - eps;
            const oy = CORNER_OFFSET_Y[c] === 0 ? eps : 1 - eps;
            vd[off] = px;
            vd[off + 1] = py;
            vd[off + 2] = pz;
            vd[off + 3] = angle;
            vd[off + 4] = w;
            vd[off + 5] = h;
            vd[off + 6] = ox;
            vd[off + 7] = oy;
            vd[off + 8] = invU;
            vd[off + 9] = invV;
            vd[off + 10] = cellLeft;
            vd[off + 11] = cellTop;
            vd[off + 12] = cellWN;
            vd[off + 13] = cellHN;
            vd[off + 14] = cr;
            vd[off + 15] = cg;
            vd[off + 16] = cb;
            vd[off + 17] = ca;
            off += FLOATS_PER_VERTEX;
        }
        visible++;
    }
    if (visible === 0) {
        return;
    }

    // ── Upload + draw (native command stream) ────────────────────────────────
    const s = engine._state;
    const vao = renderer._vao;
    if (s.boundVao !== vao) {
        dBindVertexArray(engine, vao);
        s.boundVao = vao;
        s.boundElementBuffer = renderer._ibo;
    }
    const floatCount = visible * VERTS_PER_SPRITE * FLOATS_PER_VERTEX;
    // Upload only the filled prefix — pass the byte length (no per-frame subarray).
    dUpdateVertexBuffer(engine, renderer._vbo, vd, 0, floatCount * BYTES_PER_FLOAT);

    useEffect(effect);
    setEffectMatrix(effect, "view", viewMatrix);
    setEffectMatrix(effect, "projection", projectionMatrix);
    setEffectTexture(effect, "diffuseSampler", tex);

    setBlendMode(engine, renderer.blendMode);
    applyNativeStates(engine);
    dDrawIndexed(engine, 0, visible * INDICES_PER_SPRITE, 0);
    if (renderer.autoResetAlpha) {
        setBlendMode(engine, GLBlendMode.DISABLE);
    }
}

/** Swap the sprite-sheet texture. Mirrors the WebGL `setSpriteRendererTexture`. */
export function setSpriteRendererTexture(renderer: GLSpriteRenderer, texture: GLTexture): void {
    if (renderer._disposed) {
        return;
    }
    renderer.texture = texture;
}

/** Release the renderer's native buffers + owned effect. Idempotent. */
export function disposeSpriteRenderer(renderer: GLSpriteRenderer): void {
    if (renderer._disposed) {
        return;
    }
    renderer._disposed = true;
    const engine = renderer._effect._engine;
    offContextRestored(engine, renderer._restore);
    disposeEffect(renderer._effect);
    if (!engine._isLost && !engine._disposed) {
        const s = engine._state;
        if (renderer._vao !== null) {
            dDeleteVertexArray(engine, renderer._vao);
            if (s.boundVao === renderer._vao) {
                s.boundVao = null;
            }
        }
        if (renderer._vbo !== null) {
            dDeleteVertexBuffer(engine, renderer._vbo);
        }
        if (renderer._ibo !== null) {
            dDeleteIndexBuffer(engine, renderer._ibo);
        }
    }
    renderer._vao = null;
    renderer._vbo = null;
    renderer._ibo = null;
}

/* ────────────────────────────  internal helpers  ──────────────────────────── */

/** (Re)create the native VAO + VBO + IBO and record the six vertex attributes.
 *  Attribute locations 0..5 match the shader's explicit `layout(location = i)`. */
function buildSpriteBuffers(renderer: GLSpriteRenderer): void {
    const engine = renderer._effect._engine;
    if (engine._isLost || engine._disposed) {
        return;
    }
    // Dynamic vertex buffer sized at full capacity (filled per frame).
    const vbo = dCreateVertexBuffer(engine, renderer._vertexData, true);
    const ibo = dCreateIndexBuffer(engine, renderer._indices, false, false);
    const vao = dCreateVertexArray(engine);
    // location, byteOffset, byteStride, numElements
    dRecordVertexBuffer(engine, vao, vbo, 0, 0, VERTEX_STRIDE_BYTES, 4, 0);
    dRecordVertexBuffer(engine, vao, vbo, 1, 4 * BYTES_PER_FLOAT, VERTEX_STRIDE_BYTES, 2, 0);
    dRecordVertexBuffer(engine, vao, vbo, 2, 6 * BYTES_PER_FLOAT, VERTEX_STRIDE_BYTES, 2, 0);
    dRecordVertexBuffer(engine, vao, vbo, 3, 8 * BYTES_PER_FLOAT, VERTEX_STRIDE_BYTES, 2, 0);
    dRecordVertexBuffer(engine, vao, vbo, 4, 10 * BYTES_PER_FLOAT, VERTEX_STRIDE_BYTES, 4, 0);
    dRecordVertexBuffer(engine, vao, vbo, 5, 14 * BYTES_PER_FLOAT, VERTEX_STRIDE_BYTES, 4, 0);
    dRecordIndexBuffer(engine, vao, ibo);

    renderer._vbo = vbo;
    renderer._ibo = ibo;
    renderer._vao = vao;
}
