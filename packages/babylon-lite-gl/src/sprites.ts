/**
 * Sub-entry: sprite / instanced-quad renderer.
 *
 * Dynamic-importable via `import { ... } from "@babylonjs/lite-gl/sprites"` so
 * consumers that don't render sprites don't pull it into their bundles.
 *
 * This is the lite-gl equivalent of Babylon's `SpriteRenderer` + `ThinSprite`
 * (`Sprites/spriteRenderer.js`, `Sprites/thinSprite.js`). The vertex layout,
 * per-cell UV math and corner/rotation transform are copied verbatim from the
 * non-instanced path of Babylon's `SpriteRenderer` so a future NeonBrush port
 * renders identically. The shaders are the GLSL ES 3.00 translation of
 * Babylon's `Shaders/sprites.vertex.js` / `sprites.fragment.js`, with the
 * fog / log-depth / pixel-perfect / alpha-test branches removed (lite-gl has
 * no depth attachment by default — see notes on `disableDepthWrite` below).
 */
import { offContextRestored, onContextRestored, type GLEngineContext } from "./context.js";
import { createEffect, disposeEffect, type GLEffect, isEffectReady, setEffectTexture, useEffect } from "./effect.js";
import { GLBlendMode, setBlendMode } from "./blend.js";
import { applyGLStates } from "./apply-states.js";
import { type GLTexture } from "./texture.js";

/* ─────────────────────────────  shaders (GLSL ES 3.00)  ───────────────────── */

/** Vertex shader — GLSL ES 3.00 translation of Babylon's `spritesVertexShader`
 *  core path. Attribute locations 0..5 match `createSpriteRenderer`'s
 *  `attributeNames` order so the renderer's VAO feeds every program correctly. */
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

/** Fragment shader — GLSL ES 3.00 translation of Babylon's `spritesPixelShader`
 *  color pass: `texture(diffuseSampler, vUV) * vColor`. The alpha-test/discard
 *  branch is dropped because lite-gl never runs the depth pre-pass. */
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

/** Floats per vertex: position.xyz + angle (4), size (2), corner offset (2),
 *  inverts (2), cellInfo (4), color (4) = 18. Matches Babylon's non-instanced
 *  `_vertexBufferSize`. */
const FLOATS_PER_VERTEX = 18;
/** Four corner vertices per sprite quad (non-instanced, like Babylon). */
const VERTS_PER_SPRITE = 4;
/** Six indices per sprite (two triangles). */
const INDICES_PER_SPRITE = 6;
/** Bytes per float — `Float32Array.BYTES_PER_ELEMENT`. */
const BYTES_PER_FLOAT = 4;
/** Stride between consecutive vertices, in bytes. */
const VERTEX_STRIDE_BYTES = FLOATS_PER_VERTEX * BYTES_PER_FLOAT;
/** UV inset applied to each quad corner, matching Babylon's default
 *  `SpriteRenderer` epsilon (0.01) so cell sampling never bleeds neighbours. */
const SPRITE_EPSILON = 0.01;
/** Max sprites: 4 verts/sprite must keep every index within `Uint16` range
 *  (`capacity * 4 - 1 <= 65535`). */
const MAX_CAPACITY = 16384;

/** Per-corner U offset (pre-epsilon), one entry per quad vertex. Module-scoped
 *  literal — pure per bundler convention, allocated once (never per frame). */
const CORNER_OFFSET_X = [0, 1, 1, 0];
/** Per-corner V offset (pre-epsilon), one entry per quad vertex. */
const CORNER_OFFSET_Y = [0, 0, 1, 1];

/** Attribute names in location order — index `i` is bound to `location = i` by
 *  `createEffect`/`linkProgram`, matching the shader's `layout(location = i)`. */
const SPRITE_ATTRIBUTES = ["position", "options", "offsets", "inverts", "cellInfo", "color"] as const;

/* ───────────────────────────────  public types  ──────────────────────────── */

/** An RGBA color with each channel in `[0, 1]`, used for per-sprite tint. */
export interface GLSpriteColor {
    /** Red, 0..1. */
    r: number;
    /** Green, 0..1. */
    g: number;
    /** Blue, 0..1. */
    b: number;
    /** Alpha, 0..1. */
    a: number;
}

/** A single sprite — a plain data object mirroring the fields of Babylon's
 *  `ThinSprite` that the renderer reads. No animation state: `cellIndex` is set
 *  directly by the consumer (lite-gl does not port `ThinSprite.playAnimation`). */
export interface GLSprite {
    /** World-space position of the sprite center. */
    position: { x: number; y: number; z: number };
    /** Width in world units. */
    width: number;
    /** Height in world units. */
    height: number;
    /** Rotation angle, in radians. */
    angle: number;
    /** Sprite-sheet cell index (0-based, row-major). Out-of-range / negative
     *  values are clamped to 0, matching Babylon's `if (!cellIndex) = 0`. Ignored
     *  when a manual UV rect (`uSize`) is set. Optional — defaults to `0`. */
    cellIndex?: number;
    /** Optional tint; defaults to opaque white `{ r: 1, g: 1, b: 1, a: 1 }`. */
    color?: GLSpriteColor;
    /** Flip the cell horizontally. Defaults to `false`. */
    invertU?: boolean;
    /** Flip the cell vertically. Defaults to `false`. */
    invertV?: boolean;
    /** Manual UV rect — normalized left (U) origin in `[0, 1]`, mirroring
     *  Babylon's `ThinSprite._xOffset`. Set together with {@link GLSprite.uSize}
     *  to address an arbitrary sub-rectangle of the sheet instead of the fixed
     *  `cellIndex` grid (used by the lottie atlas, whose cells vary in size). */
    uOffset?: number;
    /** Manual UV rect — normalized top (V) origin in `[0, 1]` (≙ Babylon
     *  `ThinSprite._yOffset`). See {@link GLSprite.uSize}. */
    vOffset?: number;
    /** Manual UV rect — cell width in **texels** (≙ Babylon `ThinSprite._xSize`;
     *  divided by the texture width when building vertices). Presence of `uSize`
     *  switches the sprite into manual-UV mode (the `cellIndex` grid is ignored).
     *  `0` samples a single column — the "solid color" trick. */
    uSize?: number;
    /** Manual UV rect — cell height in **texels** (≙ Babylon `ThinSprite._ySize`).
     *  See {@link GLSprite.uSize}. Defaults to `0` when `uSize` is set but `vSize`
     *  is omitted. */
    vSize?: number;
    /** When `false`, the sprite is skipped. Defaults to `true`. */
    isVisible?: boolean;
}

/** Options for {@link createSpriteRenderer}. */
export interface GLSpriteRendererOptions {
    /** Maximum number of sprites drawable in one `renderSprites` call. Must be
     *  an integer in `[1, 16384]` (the `Uint16` index-buffer limit). */
    capacity: number;
    /** Cell width in texels within the sprite sheet, for the fixed-grid
     *  `cellIndex` path. Optional — defaults to `1`; irrelevant when every
     *  sprite supplies a manual UV rect (`uSize`), as the lottie atlas does. */
    cellWidth?: number;
    /** Cell height in texels within the sprite sheet. Optional — defaults to
     *  `1`. See {@link GLSpriteRendererOptions.cellWidth}. */
    cellHeight?: number;
    /** Per-corner UV/position inset applied to each quad vertex, in the `[0, 0.5)`
     *  range — the `epsilon` constructor argument of Babylon's `SpriteRenderer`.
     *  It both insets cell UV sampling (so a cell never bleeds its neighbours) and
     *  shrinks the quad by `epsilon * size` per side. Defaults to `0.01` (Babylon's
     *  `SpriteRenderer` default). Pass `0` to disable insetting — the lottie atlas
     *  does this (it relies on edge-extruded cells + center sampling instead, so a
     *  non-zero inset would shrink every sprite by ~`0.01·size` per edge). */
    epsilon?: number;
    /** The sprite-sheet texture. May be swapped later via
     *  {@link setSpriteRendererTexture}. */
    texture: GLTexture;
    /** Blend mode for the draw. Defaults to {@link GLBlendMode.ALPHA} (2),
     *  matching Babylon's `SpriteRenderer.blendMode` default. */
    blendMode?: GLBlendMode;
    /** When `true` (default), `renderSprites` resets the blend mode to
     *  {@link GLBlendMode.DISABLE} after drawing — mirroring Babylon's
     *  `SpriteRenderer.autoResetAlpha = true`. Set `false` to leave the
     *  renderer's `blendMode` applied after the draw (the lottie player relies
     *  on this so its premultiplied alpha mode persists across passes). */
    autoResetAlpha?: boolean;
    /** Accepted for Babylon API parity. lite-gl's default engine has no depth
     *  attachment (`depth: false`), so there is no depth pre-pass and this flag
     *  has no observable effect; it is stored verbatim for a future depth-aware
     *  consumer. Defaults to `false`. */
    disableDepthWrite?: boolean;
}

/**
 * A sprite renderer owning its own VBO/IBO/VAO and `GLEffect`. Created by
 * {@link createSpriteRenderer}; drive it with {@link renderSprites} and release
 * it with {@link disposeSpriteRenderer}.
 */
export interface GLSpriteRenderer {
    /** The sprite-sheet texture sampled by the shader. Swap via
     *  {@link setSpriteRendererTexture}. */
    texture: GLTexture;
    /** Cell width in texels (selects the sub-rectangle for `cellIndex`). */
    cellWidth: number;
    /** Cell height in texels. */
    cellHeight: number;
    /** Per-corner UV/position inset (Babylon `SpriteRenderer` `epsilon`). */
    epsilon: number;
    /** Active blend mode applied by `renderSprites` before drawing. */
    blendMode: GLBlendMode;
    /** When `true`, `renderSprites` resets blend to {@link GLBlendMode.DISABLE}
     *  after drawing (Babylon `autoResetAlpha`). */
    autoResetAlpha: boolean;
    /** Babylon-parity flag (no effect without a depth attachment). */
    disableDepthWrite: boolean;
    /** Maximum sprites per draw, fixed at creation. */
    readonly capacity: number;
    /** @internal The engine the renderer was created for. */
    _engine: GLEngineContext;
    /** @internal The compiled sprite effect this renderer owns. */
    _effect: GLEffect;
    /** @internal Sprite VAO (attribute pointers + element binding). Null until
     *  built and after disposal; rebuilt on `webglcontextrestored`. */
    _vao: WebGLVertexArrayObject | null;
    /** @internal Dynamic vertex buffer, sized for `capacity` at creation. */
    _vbo: WebGLBuffer | null;
    /** @internal Static index buffer (`capacity * 6` `Uint16` indices). */
    _ibo: WebGLBuffer | null;
    /** @internal Preallocated CPU-side vertex scratch — reused every frame
     *  (`renderSprites` performs zero allocations). */
    _vertexData: Float32Array;
    /** @internal Preallocated index data, uploaded once. */
    _indices: Uint16Array;
    /** @internal Context-restored handler — rebuilds the GPU buffers. */
    _restore: () => void;
    /** @internal True once disposed; subsequent calls are no-ops. */
    _disposed: boolean;
}

/* ────────────────────────────────  public API  ───────────────────────────── */

/**
 * Create a sprite renderer with its own GPU buffers and compiled effect.
 *
 * Preallocates the CPU vertex scratch and the index buffer at `capacity`, so
 * {@link renderSprites} performs no allocations. The sprite GPU buffers are
 * rebuilt automatically on `webglcontextrestored` (the owned effect is rebuilt
 * by the engine's context-restore protocol).
 *
 * @param engine - The engine to create GL resources on.
 * @param options - See {@link GLSpriteRendererOptions}.
 * @returns The new {@link GLSpriteRenderer}.
 * @throws If `capacity` is not an integer in `[1, 16384]`, or if a provided
 *  `cellWidth`/`cellHeight` is not positive.
 */
export function createSpriteRenderer(engine: GLEngineContext, options: GLSpriteRendererOptions): GLSpriteRenderer {
    const capacity = options.capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
        throw new Error(`lite-gl: sprite renderer capacity must be an integer in [1, ${MAX_CAPACITY}], got ${capacity}`);
    }
    // cellWidth/cellHeight drive only the fixed-grid `cellIndex` path; manual-UV
    // consumers (the lottie atlas) omit them. Default to 1; reject explicit ≤ 0.
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

    // Build the static index buffer data once: [0,1,2, 0,2,3] per sprite.
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
        _engine: engine,
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
 * Build the per-sprite vertex data and draw all visible sprites in one
 * `drawElements` call. Performs no allocations — the vertex scratch is reused
 * and uploaded with `bufferSubData`.
 *
 * No-op when the context is lost/disposed, the renderer is disposed, the
 * texture is not ready, the effect is not ready, or there are no visible
 * sprites. Sets the renderer's blend mode before drawing and resets to
 * {@link GLBlendMode.DISABLE} afterwards (matching Babylon's
 * `autoResetAlpha = true`), so a subsequent `drawEffect` is unaffected.
 *
 * @param renderer - The renderer to draw with.
 * @param sprites - The sprites to draw (only `isVisible !== false` are drawn;
 *  excess beyond `capacity` is ignored, matching Babylon).
 * @param deltaTime - Accepted for Babylon API parity; unused (lite-gl `GLSprite`
 *  holds no animation state, so `cellIndex` is consumer-driven).
 * @param viewMatrix - Column-major 4x4 view matrix.
 * @param projectionMatrix - Column-major 4x4 projection matrix.
 */
export function renderSprites(
    renderer: GLSpriteRenderer,
    sprites: readonly GLSprite[],
    deltaTime: number,
    viewMatrix: Float32Array | number[],
    projectionMatrix: Float32Array | number[]
): void {
    const engine = renderer._engine;
    if (engine._isLost || engine._disposed || renderer._disposed) {
        return;
    }
    // `deltaTime` is accepted for Babylon `SpriteRenderer.render` parity but
    // unused: `GLSprite` carries no animation state, so `cellIndex` is driven
    // entirely by the consumer. Referenced here to keep the parameter name in
    // the public signature without tripping `noUnusedParameters`.
    void deltaTime;
    const tex = renderer.texture;
    if (!tex.isReady || sprites.length === 0) {
        return;
    }
    const effect = renderer._effect;
    if (!isEffectReady(engine, effect)) {
        return;
    }
    if (renderer._vao === null || renderer._vbo === null) {
        return;
    }

    // ── Build vertex data (allocation-free) ──────────────────────────────────
    const vd = renderer._vertexData;
    const eps = renderer.epsilon;
    const texW = tex.width;
    const texH = tex.height;
    const cellW = renderer.cellWidth;
    const cellH = renderer.cellHeight;
    const rowSize = texW / cellW; // cells per sheet row
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
        // UV rect — manual per-sprite rect (Babylon `ThinSprite._xOffset/_xSize`
        // path, selected when `uSize` is set) or the fixed `cellIndex` grid.
        // Both resolve to a normalized `(left, top, widthN, heightN)` rectangle,
        // matching Babylon's `_appendSpriteVertex` vertex layout exactly.
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

    // ── Upload + draw ────────────────────────────────────────────────────────
    const gl = engine.gl;
    const s = engine._state;
    const vao = renderer._vao;
    if (s.boundVao !== vao) {
        gl.bindVertexArray(vao);
        s.boundVao = vao;
        // Binding the VAO restores its element-array binding (VAO state).
        s.boundElementBuffer = renderer._ibo;
    }
    const vbo = renderer._vbo;
    if (s.boundArrayBuffer !== vbo) {
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        s.boundArrayBuffer = vbo;
    }
    const floatCount = visible * VERTS_PER_SPRITE * FLOATS_PER_VERTEX;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vd, 0, floatCount);

    useEffect(engine, effect);
    const viewLoc = effect.uniformLocations["view"];
    if (viewLoc !== null && viewLoc !== undefined) {
        gl.uniformMatrix4fv(viewLoc, false, viewMatrix);
    }
    const projLoc = effect.uniformLocations["projection"];
    if (projLoc !== null && projLoc !== undefined) {
        gl.uniformMatrix4fv(projLoc, false, projectionMatrix);
    }
    setEffectTexture(engine, effect, "diffuseSampler", tex);

    setBlendMode(engine, renderer.blendMode);
    applyGLStates(engine);
    gl.drawElements(gl.TRIANGLES, visible * INDICES_PER_SPRITE, gl.UNSIGNED_SHORT, 0);
    // Auto-reset (Babylon `autoResetAlpha = true`): leave blend disabled so a
    // subsequent fullscreen `drawEffect` renders with the same state as before.
    // When `autoResetAlpha` is false (lottie), keep `renderer.blendMode` applied
    // so a premultiplied-alpha mode persists across multiple atlas-page passes.
    if (renderer.autoResetAlpha) {
        setBlendMode(engine, GLBlendMode.DISABLE);
    }
}

/** Swap the sprite-sheet texture (≙ Babylon assigning `SpriteRenderer.texture`
 *  after an async load). The cell size is unchanged — adjust `cellWidth` /
 *  `cellHeight` on the renderer directly if the new sheet differs. No-op when
 *  the renderer is disposed. */
export function setSpriteRendererTexture(renderer: GLSpriteRenderer, texture: GLTexture): void {
    if (renderer._disposed) {
        return;
    }
    renderer.texture = texture;
}

/** Release the renderer's VAO/VBO/IBO and the effect it owns, and unregister
 *  its context-restore handler. Idempotent. Does NOT dispose the texture — the
 *  consumer that supplied it owns its lifetime. */
export function disposeSpriteRenderer(renderer: GLSpriteRenderer): void {
    if (renderer._disposed) {
        return;
    }
    renderer._disposed = true;
    const engine = renderer._engine;
    offContextRestored(engine, renderer._restore);
    disposeEffect(engine, renderer._effect);
    if (!engine._isLost && !engine._disposed) {
        const gl = engine.gl;
        const s = engine._state;
        if (renderer._vao !== null) {
            gl.deleteVertexArray(renderer._vao);
            if (s.boundVao === renderer._vao) {
                s.boundVao = null;
            }
        }
        if (renderer._vbo !== null) {
            gl.deleteBuffer(renderer._vbo);
            if (s.boundArrayBuffer === renderer._vbo) {
                s.boundArrayBuffer = null;
            }
        }
        if (renderer._ibo !== null) {
            gl.deleteBuffer(renderer._ibo);
            if (s.boundElementBuffer === renderer._ibo) {
                s.boundElementBuffer = null;
            }
        }
    }
    renderer._vao = null;
    renderer._vbo = null;
    renderer._ibo = null;
}

/* ────────────────────────────  internal helpers  ──────────────────────────── */

/** (Re)create the VAO + VBO + IBO and configure the six vertex attributes.
 *  Called from `createSpriteRenderer` and from the `webglcontextrestored`
 *  handler (the prior handles are dead per the WebGL spec — not deleted here).
 *  No-op when the context is lost/disposed. */
function buildSpriteBuffers(renderer: GLSpriteRenderer): void {
    const engine = renderer._engine;
    if (engine._isLost || engine._disposed) {
        return;
    }
    const gl = engine.gl;
    const s = engine._state;

    const vao = gl.createVertexArray();
    if (vao === null) {
        throw new Error("lite-gl: gl.createVertexArray returned null (sprite VAO)");
    }
    renderer._vao = vao;
    gl.bindVertexArray(vao);
    s.boundVao = vao;

    const vbo = gl.createBuffer();
    if (vbo === null) {
        throw new Error("lite-gl: gl.createBuffer returned null (sprite VBO)");
    }
    renderer._vbo = vbo;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    s.boundArrayBuffer = vbo;
    // Allocate the dynamic vertex storage at full capacity; filled per frame.
    gl.bufferData(gl.ARRAY_BUFFER, renderer._vertexData.byteLength, gl.DYNAMIC_DRAW);

    // Attribute pointers — locations match SPRITE_ATTRIBUTES / shader layout.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 4 * BYTES_PER_FLOAT);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 6 * BYTES_PER_FLOAT);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 8 * BYTES_PER_FLOAT);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 10 * BYTES_PER_FLOAT);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 14 * BYTES_PER_FLOAT);

    const ibo = gl.createBuffer();
    if (ibo === null) {
        throw new Error("lite-gl: gl.createBuffer returned null (sprite IBO)");
    }
    renderer._ibo = ibo;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    s.boundElementBuffer = ibo;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, renderer._indices, gl.STATIC_DRAW);
}
