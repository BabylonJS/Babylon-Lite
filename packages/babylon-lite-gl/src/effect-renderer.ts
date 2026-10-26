import type { GLEngineContext } from "./context.js";
import { createEffect, disposeEffect, type GLEffect, isEffectReady, useEffect } from "./effect.js";
import { applyGLStates } from "./apply-states.js";

/** Built-in fullscreen-quad vertex shader, used when `GLEffectWrapperOptions`
 *  omits `vertexSource`. Maps the package's fullscreen-quad positions
 *  (attribute location 0) to clip space and forwards a 0..1 `vUv` varying —
 *  the WebGL counterpart of lite's default `vertexWGSL`, so callers can pass
 *  only `fragmentSource`. */
const DEFAULT_FULLSCREEN_VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 vUv;
void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}`;

/** Inputs to `createEffectWrapper`. Mirrors lite's `EffectWrapperOptions`: the
 *  wrapper compiles and OWNS the effect built from this shader source. */
export interface GLEffectWrapperOptions {
    /** Human-readable label for the wrapper and its effect. Defaults to
     *  `"effect-wrapper"`. */
    name?: string;
    /** GLSL ES 3.00 vertex source. Defaults to a built-in fullscreen-quad
     *  vertex shader (exposing a `vUv` varying), mirroring lite's default
     *  `vertexWGSL`. */
    vertexSource?: string;
    /** GLSL ES 3.00 fragment source (≙ lite's `fragmentWGSL`). Required. */
    fragmentSource: string;
    /** Declared uniform names. Defaults to none. */
    uniformNames?: readonly string[];
    /** Declared sampler names, in unit-assignment order. Defaults to none. */
    samplerNames?: readonly string[];
    /** Attribute names; the first is bound to location 0. Defaults to
     *  `["position"]`. */
    attributeNames?: readonly string[];
    /** Optional `#define` block prepended to both shader stages. */
    defines?: string;
}

/** A reusable fullscreen effect that compiles and OWNS its `GLEffect` — the
 *  WebGL counterpart of lite's `EffectWrapper`. Like every lite-gl function,
 *  the wrapper functions take the owning engine first:
 *  `applyEffectWrapper(engine, wrapper)` / `disposeEffectWrapper(engine, wrapper)`. */
export interface GLEffectWrapper {
    /** Name alias for the wrapper (and its effect). */
    readonly name: string;
    /** The compiled effect this wrapper owns. Exposed so the per-uniform
     *  setters (`setEffectFloat`/`setEffectTexture`/…) can target it — the
     *  WebGL divergence from lite's UBO-based `setEffectUniforms(wrapper, …)`. */
    readonly effect: GLEffect;
    /** @internal */
    _disposed: boolean;
}

/** Compile a fullscreen effect from shader source and wrap it; the wrapper OWNS
 *  the resulting `GLEffect`. Mirrors lite's `createEffectWrapper(engine, options)`.
 *  When `vertexSource` is omitted, a built-in fullscreen-quad vertex shader is
 *  used, so callers can supply only `fragmentSource`. */
export function createEffectWrapper(engine: GLEngineContext, options: GLEffectWrapperOptions): GLEffectWrapper {
    const name = options.name ?? "effect-wrapper";
    const effect = createEffect(engine, {
        name,
        vertexSource: options.vertexSource ?? DEFAULT_FULLSCREEN_VERTEX_SOURCE,
        fragmentSource: options.fragmentSource,
        uniformNames: options.uniformNames ?? [],
        samplerNames: options.samplerNames ?? [],
        attributeNames: options.attributeNames,
        defines: options.defines,
    });
    return { name, effect, _disposed: false };
}

/** Dispose the wrapper and the effect it owns (idempotent).
 *
 *  @param engine - The engine the wrapper was created on.
 *  @param wrapper - The wrapper to dispose. */
export function disposeEffectWrapper(engine: GLEngineContext, wrapper: GLEffectWrapper): void {
    if (wrapper._disposed) {
        return;
    }
    wrapper._disposed = true;
    disposeEffect(engine, wrapper.effect);
}

/** Pixel-space viewport rectangle passed to `setViewport`. */
export interface GLViewport {
    /** Lower-left X origin in physical pixels. */
    x: number;
    /** Lower-left Y origin in physical pixels. */
    y: number;
    /** Width in physical pixels. */
    w: number;
    /** Height in physical pixels. */
    h: number;
}

/** Cached `gl.viewport`. Defaults to the full canvas in pixel coordinates. */
export function setViewport(engine: GLEngineContext, viewport?: GLViewport): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const x = viewport?.x ?? 0;
    const y = viewport?.y ?? 0;
    const w = viewport?.w ?? engine.canvas.width;
    const h = viewport?.h ?? engine.canvas.height;
    const s = engine._state;
    if (s.viewportX === x && s.viewportY === y && s.viewportW === w && s.viewportH === h) {
        return;
    }
    s.viewportX = x;
    s.viewportY = y;
    s.viewportW = w;
    s.viewportH = h;
    engine.gl.viewport(x, y, w, h);
}

/** Make `wrapper.effect` current — the counterpart of Babylon's
 *  `EffectRenderer.applyEffectWrapper` (lite-gl has no `setEffectWrapper`;
 *  this is the only wrapper "activate" call). The shared fullscreen quad is
 *  bound by {@link drawEffect}, so an existing `GLEffect` needs no wrapper:
 *  `if (isEffectReady(engine, e)) { useEffect(engine, e); …setters…; drawEffect(engine); }`.
 *
 *  The wrapper's effect must be ready: this polls {@link isEffectReady} itself
 *  (finalizing the effect on its first ready poll) and returns `false` without
 *  binding anything while the shaders are still compiling, failed to compile,
 *  or the context is lost/disposed — skip the frame's `setEffect*` /
 *  `drawEffect` calls in that case, otherwise they target whatever program
 *  was current before.
 *
 *  This MUST be called BEFORE any `setEffect*` call for the same effect in the
 *  current frame (uniform setters write to the currently bound program).
 *  Typical frame:
 *  `if (!applyEffectWrapper(engine, w)) return;` →
 *  `setEffectFloat(engine, w.effect, …)` → `drawEffect(engine)`.
 *
 *  @param engine - The engine the wrapper was created on.
 *  @param wrapper - The wrapper whose effect to make current.
 *  @returns `true` when the effect is ready and now current; `false` when
 *   nothing was bound. */
export function applyEffectWrapper(engine: GLEngineContext, wrapper: GLEffectWrapper): boolean {
    // Poll first: ready callbacks fired by the poll may dispose the wrapper.
    if (!isEffectReady(engine, wrapper.effect) || wrapper._disposed) {
        return false;
    }
    useEffect(engine, wrapper.effect);
    return true;
}

/** Draw the shared fullscreen quad with the current program (from
 *  {@link applyEffectWrapper} or `useEffect`) — the counterpart of Babylon's
 *  `EffectRenderer.draw`. Lazily creates the quad on first use (and after
 *  context restore), binds its VAO (cached), flushes the deferred GL states and
 *  issues `gl.drawElements(TRIANGLES, 6, UNSIGNED_SHORT, 0)`. The program's
 *  vertex shader must read the quad positions at attribute location 0 (as
 *  `createEffectWrapper`'s default vertex shader does). No-op when the context
 *  is lost/disposed or there is no current program.
 *
 *  @param engine - The engine. */
export function drawEffect(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    if (engine._state.currentProgram === null) {
        return;
    }
    ensureQuad(engine);
    applyGLStates(engine);
    engine.gl.drawElements(engine.gl.TRIANGLES, 6, engine.gl.UNSIGNED_SHORT, 0);
}

/** Lazy fullscreen quad. Built on first call; thereafter the VAO is cached on
 *  `_state.quadVao` and rebinding is a single cached call. Cleared by
 *  `webglcontextlost` and transparently rebuilt by the next
 *  `drawEffect` after restore.
 *
 *  Position attribute is enabled at location 0 — every effect's
 *  `createEffect` calls `gl.bindAttribLocation(program, 0, attributeNames[0])`
 *  BEFORE link, so the shared VAO is correct across all programs. */
function ensureQuad(engine: GLEngineContext): void {
    const s = engine._state;
    const gl = engine.gl;
    if (s.quadVao !== null) {
        if (s.boundVao !== s.quadVao) {
            gl.bindVertexArray(s.quadVao);
            s.boundVao = s.quadVao;
        }
        return;
    }
    const vao = gl.createVertexArray();
    if (vao === null) {
        throw new Error("lite-gl: gl.createVertexArray returned null");
    }
    s.quadVao = vao;
    gl.bindVertexArray(vao);
    s.boundVao = vao;

    const vbo = gl.createBuffer();
    if (vbo === null) {
        throw new Error("lite-gl: gl.createBuffer returned null (VBO)");
    }
    s.quadVbo = vbo;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    s.boundArrayBuffer = vbo;
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_POSITIONS, gl.STATIC_DRAW);

    const ibo = gl.createBuffer();
    if (ibo === null) {
        throw new Error("lite-gl: gl.createBuffer returned null (IBO)");
    }
    s.quadIbo = ibo;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    s.boundElementBuffer = ibo;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, QUAD_INDICES, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

/** Typed-array literal — pure per bundler convention. Matches Babylon's
 *  `EffectRenderer` default geometry exactly. */
const QUAD_POSITIONS = new Float32Array([1, 1, -1, 1, -1, -1, 1, -1]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
