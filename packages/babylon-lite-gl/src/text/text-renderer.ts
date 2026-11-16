import type { GLEngineContext } from "../context.js";
import { offContextLost, onContextLost } from "../context.js";
import { disposeEffect, isEffectReady, setEffectTexture } from "../effect.js";
import { createVertexBuffer, disposeBuffer } from "../mesh.js";
import type { GLVertexBuffer } from "../mesh.js";
import { disableBlend, setBlendState } from "../blend.js";
import { applyGLStates } from "../apply-states.js";
import { clearEngine, setColorMask, setCullState, setDepthState } from "../depth-stencil.js";
import type { GLClearOptions } from "../depth-stencil.js";
import { setViewport } from "../effect-renderer.js";
import type { GLViewport } from "../effect-renderer.js";
import { runRenderLoop, stopRenderLoop } from "../render-loop.js";
import type { GLTextData } from "./text-data.js";
import { ensureSharedAtlasGpu } from "./_gpu/text-textures.js";
import { ensureTextDataGpu } from "./_gpu/text-instances.js";
import { _createTextVariant, createTextProgram, uploadTextUniforms } from "./_gpu/text-effect.js";
import type { TextProgram } from "./_gpu/text-effect.js";
import { bindTextVao, disposeTextVao } from "./_gpu/text-vao.js";
import type { TextVao } from "./_gpu/text-vao.js";

/** Pixel-space placement and compositing of one text block. */
export interface GLTextLayerOptions {
    readonly positionPx?: { readonly x: number; readonly y: number };
    readonly rotationRad?: number;
    readonly scale?: number;
    readonly order?: number;
    readonly opacity?: number;
    /** Raises analytic coverage to 1/gamma. Default 1; values above 1 darken edges. */
    readonly coverageGamma?: number;
    readonly visible?: boolean;
}

/** Mutable placement of borrowed text data. Positions are in target pixels, not CSS pixels. */
export interface GLTextLayer {
    readonly data: GLTextData;
    positionPx: { x: number; y: number };
    rotationRad: number;
    scale: number;
    order: number;
    opacity: number;
    coverageGamma: number;
    visible: boolean;
}

/** Create a pure-data layer; rendering does not transfer ownership of its text data. */
export function createTextLayer(data: GLTextData, options?: GLTextLayerOptions): GLTextLayer {
    return {
        data,
        positionPx: { x: options?.positionPx?.x ?? 0, y: options?.positionPx?.y ?? 0 },
        rotationRad: options?.rotationRad ?? 0,
        scale: options?.scale ?? 1,
        order: options?.order ?? 0,
        opacity: options?.opacity ?? 1,
        coverageGamma: options?.coverageGamma ?? 1,
        visible: options?.visible ?? true,
    };
}

/** Set the layer's baseline origin in target pixels. */
export function setTextLayerPosition(layer: GLTextLayer, x: number, y: number): void {
    layer.positionPx.x = x;
    layer.positionPx.y = y;
}

/** Options for drawing text to the currently bound canvas or render target. */
export interface GLTextRendererOptions {
    layers: readonly GLTextLayer[];
    /** Default true. Disable to draw an overlay without clearing existing color. */
    clear?: boolean;
    /** Default opaque black. */
    clearValue?: { r: number; g: number; b: number; a?: number };
}

/** @internal */
interface DataDrawState {
    _layoutVersion: number;
    _hasVariant: boolean;
    _vaos: (TextVao | undefined)[];
}

/** Standalone WebGL2 analytic text renderer; owns programs/VAOs, not its layers' data. */
export interface GLTextRenderer {
    readonly layers: readonly GLTextLayer[];
    /** @internal */ _layers: GLTextLayer[];
    /** @internal */ _engine: GLEngineContext;
    /** @internal */ _base: TextProgram;
    /** @internal */ _variant: TextProgram | null;
    /** @internal */ _quad: GLVertexBuffer;
    /** @internal */ _drawState: Map<GLTextData, DataDrawState>;
    /** @internal */ _viewport: GLViewport;
    /** @internal */ _clearOptions: GLClearOptions | null;
    /** @internal */ _loopFn: ((dt: number) => void) | null;
    /** @internal */ _onLost: () => void;
    /** @internal */ _disposed: boolean;
}

const QUAD_CORNERS = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
const TEXT_DEPTH_STATE = { test: false, write: false };
// Premultiplied source-over, including alpha (the general GL preset accumulates alpha).
const TEXT_BLEND_STATE = { srcRGB: 1, dstRGB: 0x0303, srcAlpha: 1, dstAlpha: 0x0303 };

/** Create a renderer. Poll readiness before relying on its first draw. */
export function createTextRenderer(engine: GLEngineContext, options: GLTextRendererOptions): GLTextRenderer {
    if (engine._isLost || engine._disposed) {
        throw new Error("lite-gl: cannot create a text renderer on a lost or disposed engine.");
    }
    const base = createTextProgram(engine);
    let quad: GLVertexBuffer;
    try {
        quad = createVertexBuffer(engine, QUAD_CORNERS);
    } catch (error) {
        disposeEffect(base._effect);
        throw error;
    }
    const layers = options.layers.slice();
    const drawState = new Map<GLTextData, DataDrawState>();
    const onLost = (): void => drawState.clear();
    const renderer: GLTextRenderer = {
        layers,
        _layers: layers,
        _engine: engine,
        _base: base,
        _variant: null,
        _quad: quad,
        _drawState: drawState,
        _viewport: { x: 0, y: 0, w: 0, h: 0 },
        _clearOptions: options.clear === false ? null : { color: options.clearValue ?? { r: 0, g: 0, b: 0, a: 1 } },
        _loopFn: null,
        _onLost: onLost,
        _disposed: false,
    };
    onContextLost(engine, onLost);
    return renderer;
}

function getDrawState(renderer: GLTextRenderer, data: GLTextData): DataDrawState {
    let state = renderer._drawState.get(data);
    if (!state) {
        state = { _layoutVersion: -1, _hasVariant: false, _vaos: [] };
        renderer._drawState.set(data, state);
    }
    if (state._layoutVersion !== data._layoutVersion) {
        state._hasVariant = false;
        for (const group of data._groups) {
            state._hasVariant ||= group._groupKey !== group._curveSetId;
        }
        for (let i = data._groups.length; i < state._vaos.length; i++) {
            const vao = state._vaos[i];
            if (vao) {
                disposeTextVao(renderer._engine, vao);
            }
        }
        state._vaos.length = Math.min(state._vaos.length, data._groups.length);
        state._layoutVersion = data._layoutVersion;
    }
    return state;
}

/** True only when all shader variants needed by visible layers have linked. */
export function isTextRendererReady(renderer: GLTextRenderer): boolean {
    const engine = renderer._engine;
    if (renderer._disposed || engine._isLost || engine._disposed || !isEffectReady(renderer._base._effect)) {
        return false;
    }
    if (!renderer._variant && _createTextVariant) {
        for (const layer of renderer._layers) {
            if (layer.visible && getDrawState(renderer, layer.data)._hasVariant) {
                renderer._variant = _createTextVariant(engine);
                break;
            }
        }
    }
    return !renderer._variant || isEffectReady(renderer._variant._effect);
}

function compareLayers(a: GLTextLayer, b: GLTextLayer): number {
    return a.order - b.order;
}

/** Draw visible layers to the bound target, respecting existing scissor/stencil clipping.
 * Returns draw-call count. An unfinished shader or lost/disposed context draws nothing. */
export function renderText(renderer: GLTextRenderer): number {
    if (!isTextRendererReady(renderer)) {
        return 0;
    }
    const engine = renderer._engine;
    const gl = engine.gl;
    const target = engine._currentRenderTarget;
    const width = target?.width ?? engine.canvas.width;
    const height = target?.height ?? engine.canvas.height;
    if (width === 0 || height === 0) {
        return 0;
    }
    renderer._viewport.w = width;
    renderer._viewport.h = height;
    setViewport(engine, renderer._viewport);
    setDepthState(engine, TEXT_DEPTH_STATE);
    setCullState(engine, false);
    setColorMask(engine, true, true, true, true);
    setBlendState(engine, TEXT_BLEND_STATE);
    gl.frontFace(gl.CCW);
    if (renderer._clearOptions) {
        clearEngine(engine, renderer._clearOptions);
    }
    applyGLStates(engine);
    if (renderer._layers.length > 1) {
        renderer._layers.sort(compareLayers);
    }
    let draws = 0;
    for (const layer of renderer._layers) {
        if (!layer.visible || layer.data._instanceCount === 0) {
            continue;
        }
        const data = layer.data;
        const gpu = ensureTextDataGpu(engine, data);
        const state = getDrawState(renderer, data);
        let currentProgram: TextProgram | null = null;
        for (let i = 0; i < data._groups.length; i++) {
            const group = data._groups[i]!;
            if (group._slotCount === 0) {
                continue;
            }
            const program = group._groupKey === group._curveSetId ? renderer._base : renderer._variant!;
            if (currentProgram !== program) {
                uploadTextUniforms(program, layer, width, height);
                setEffectTexture(program._effect, "styles", gpu._styleTex);
                currentProgram = program;
            }
            const atlas = ensureSharedAtlasGpu(engine, group._curveSet._atlas);
            setEffectTexture(program._effect, "curveTex", atlas._curveTex);
            setEffectTexture(program._effect, "bandTex", atlas._bandTex);
            setEffectTexture(program._effect, "glyphMetadata", atlas._metaTex);
            state._vaos[i] = bindTextVao(engine, renderer._quad, gpu._instanceBuf, group._slotStart, state._vaos[i]);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, group._slotCount);
            draws++;
        }
    }
    disableBlend(engine);
    return draws;
}

/** Append a layer without transferring ownership. Duplicate references are ignored. */
export function addTextRendererLayer(renderer: GLTextRenderer, layer: GLTextLayer): void {
    if (!renderer._disposed && !renderer._layers.includes(layer)) {
        renderer._layers.push(layer);
    }
}

/** Remove a layer and release VAOs no longer used by any remaining layer. */
export function removeTextRendererLayer(renderer: GLTextRenderer, layer: GLTextLayer): boolean {
    const index = renderer._layers.indexOf(layer);
    if (index < 0) {
        return false;
    }
    renderer._layers.splice(index, 1);
    if (!renderer._layers.some((remaining) => remaining.data === layer.data)) {
        const state = renderer._drawState.get(layer.data);
        if (state) {
            for (const vao of state._vaos) {
                if (vao) {
                    disposeTextVao(renderer._engine, vao);
                }
            }
            renderer._drawState.delete(layer.data);
        }
    }
    return true;
}

/** Register one automatic draw callback with the engine's render loop. Idempotent. */
export function registerTextRenderer(renderer: GLTextRenderer): void {
    if (renderer._disposed || renderer._loopFn !== null) {
        return;
    }
    renderer._loopFn = (): void => {
        renderText(renderer);
    };
    runRenderLoop(renderer._engine, renderer._loopFn);
}

/** Remove only this renderer's automatic draw callback. */
export function unregisterTextRenderer(renderer: GLTextRenderer): void {
    if (renderer._loopFn) {
        stopRenderLoop(renderer._engine, renderer._loopFn);
        renderer._loopFn = null;
    }
}

/** Release owned programs, quad and VAOs. Borrowed text data/storage stay alive. */
export function disposeTextRenderer(renderer: GLTextRenderer): void {
    if (renderer._disposed) {
        return;
    }
    unregisterTextRenderer(renderer);
    renderer._disposed = true;
    const engine = renderer._engine;
    offContextLost(engine, renderer._onLost);
    for (const state of renderer._drawState.values()) {
        for (const vao of state._vaos) {
            if (vao) {
                disposeTextVao(engine, vao);
            }
        }
    }
    renderer._drawState.clear();
    disposeEffect(renderer._base._effect);
    if (renderer._variant) {
        disposeEffect(renderer._variant._effect);
    }
    disposeBuffer(renderer._quad);
    renderer._layers.length = 0;
}
