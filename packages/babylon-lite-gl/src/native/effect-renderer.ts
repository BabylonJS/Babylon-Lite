/**
 * Native effect-renderer — the native-backend twin of `effect-renderer.ts`.
 * Mirrors its PUBLIC API (createEffectWrapper / applyEffectWrapper / drawEffect /
 * setViewport / disposeEffectWrapper) so fullscreen-effect consumers are
 * source-compatible. The shared fullscreen quad is a native VAO recorded once at
 * attribute location 0 (every lite-gl vertex shader declares
 * `layout(location = 0) in … position`), reused across effects.
 */
import type { GLEngineContext } from "./native-context.js";
import { createEffect, disposeEffect, type GLEffect, isEffectReady, useEffect } from "./effect.js";
import { applyNativeStates } from "./native-apply-states.js";
import {
    dBindVertexArray,
    dCreateIndexBuffer,
    dCreateVertexArray,
    dCreateVertexBuffer,
    dDrawIndexed,
    dRecordIndexBuffer,
    dRecordVertexBuffer,
    dSetViewport,
} from "./native-device.js";

/** Built-in fullscreen-quad vertex shader (matches the WebGL default). */
const DEFAULT_FULLSCREEN_VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 vUv;
void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}`;

/** Fullscreen-quad geometry — identical to the WebGL module. */
const QUAD_POSITIONS = new Float32Array([1, 1, -1, 1, -1, -1, 1, -1]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

/** Inputs to {@link createEffectWrapper} — same shape as the WebGL module. */
export interface GLEffectWrapperOptions {
    /** Wrapper label. Default `"effect-wrapper"`. */
    name?: string;
    /** GLSL ES 3.00 vertex source. Defaults to the built-in fullscreen quad. */
    vertexSource?: string;
    /** GLSL ES 3.00 fragment source. Required. */
    fragmentSource: string;
    /** Declared uniform names. */
    uniformNames?: readonly string[];
    /** Declared sampler names. */
    samplerNames?: readonly string[];
    /** Attribute names (first bound to location 0). Default `["position"]`. */
    attributeNames?: readonly string[];
    /** Optional `#define` block. */
    defines?: string;
}

/** A reusable fullscreen effect that owns its {@link GLEffect}. */
export interface GLEffectWrapper {
    /** Name alias. */
    readonly name: string;
    /** The compiled effect this wrapper owns. */
    readonly effect: GLEffect;
    /** @internal */
    _disposed: boolean;
}

/** Pixel-space viewport rectangle — same shape as the WebGL module. */
export interface GLViewport {
    /** Lower-left X in physical pixels. */
    x: number;
    /** Lower-left Y in physical pixels. */
    y: number;
    /** Width in physical pixels. */
    w: number;
    /** Height in physical pixels. */
    h: number;
}

/** Compile a fullscreen effect and wrap it. Mirrors the WebGL `createEffectWrapper`. */
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

/** Dispose the wrapper and the effect it owns (idempotent). */
export function disposeEffectWrapper(wrapper: GLEffectWrapper): void {
    if (wrapper._disposed) {
        return;
    }
    wrapper._disposed = true;
    disposeEffect(wrapper.effect);
}

/**
 * Cached viewport (`COMMAND_SETVIEWPORT`). Same API as the WebGL `setViewport`
 * (lower-left pixel rect, defaulting to the full render surface), but the native
 * `COMMAND_SETVIEWPORT` expects NORMALIZED (0-1) coordinates relative to the
 * BOUND framebuffer — the host applies `1 - y - height` and multiplies by that
 * framebuffer's size — so the pixel rect is divided by the bound render target's
 * size (or the render surface size when the default framebuffer is bound).
 * @param engine - The engine.
 * @param viewport - Pixel rect; omitted → the full render surface.
 */
export function setViewport(engine: GLEngineContext, viewport?: GLViewport): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const sw = engine._engine.getRenderWidth() || 1;
    const sh = engine._engine.getRenderHeight() || 1;
    const rt = engine._currentRenderTarget;
    const rw = rt ? rt.width || 1 : sw;
    const rh = rt ? rt.height || 1 : sh;
    const x = (viewport?.x ?? 0) / rw;
    const y = (viewport?.y ?? 0) / rh;
    const w = (viewport?.w ?? sw) / rw;
    const h = (viewport?.h ?? sh) / rh;
    const s = engine._state;
    if (s.viewportX === x && s.viewportY === y && s.viewportW === w && s.viewportH === h) {
        return;
    }
    s.viewportX = x;
    s.viewportY = y;
    s.viewportW = w;
    s.viewportH = h;
    dSetViewport(engine, x, y, w, h);
}

/** Make `wrapper.effect` current and bind the shared quad VAO. Mirrors the
 *  WebGL `applyEffectWrapper`: returns `false` (doing nothing) while the effect
 *  is still compiling, failed, or the wrapper/engine is disposed or lost.
 *  @param wrapper - The wrapper to activate; its engine comes from `wrapper.effect`.
 *  @returns `true` when the effect is current and ready to draw. */
export function applyEffectWrapper(wrapper: GLEffectWrapper): boolean {
    const engine = wrapper.effect._engine;
    if (wrapper._disposed || engine._isLost || engine._disposed || !isEffectReady(wrapper.effect) || wrapper._disposed) {
        return false;
    }
    ensureQuad(engine);
    useEffect(wrapper.effect);
    return true;
}

/** Draw the fullscreen quad (`COMMAND_DRAWINDEXED`). No-op when there is no
 *  current program. Mirrors the WebGL `drawEffect`. */
export function drawEffect(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed || engine._state.currentProgram === null) {
        return;
    }
    ensureQuad(engine);
    applyNativeStates(engine);
    dDrawIndexed(engine, 0, 6, 0);
}

/** Lazily build + bind the shared fullscreen quad VAO. Cleared on device-lost and
 *  rebuilt on the next `applyEffectWrapper` / `drawEffect`. */
function ensureQuad(engine: GLEngineContext): void {
    const s = engine._state;
    if (s.quadVao !== null) {
        if (s.boundVao !== s.quadVao) {
            dBindVertexArray(engine, s.quadVao);
            s.boundVao = s.quadVao;
        }
        return;
    }
    const vbo = dCreateVertexBuffer(engine, QUAD_POSITIONS, false);
    const ibo = dCreateIndexBuffer(engine, QUAD_INDICES, false, false);
    const vao = dCreateVertexArray(engine);
    // position: location 0, 2 floats, tightly packed (stride = 8 bytes).
    dRecordVertexBuffer(engine, vao, vbo, 0, 0, 8, 2, 0);
    dRecordIndexBuffer(engine, vao, ibo);
    s.quadVbo = vbo;
    s.quadIbo = ibo;
    s.quadVao = vao;
    dBindVertexArray(engine, vao);
    s.boundVao = vao;
}
