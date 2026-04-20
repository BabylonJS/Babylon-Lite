/**
 * Scene2DContext — a separate scene type for pure-2D rendering.
 *
 * No depth attachment, no MSAA (samples=1), no perspective camera, no lights.
 * A single render pass that draws every Sprite2DLayer in `order` ascending.
 *
 * `startEngine2D` runs deferred builders (one per layer) and starts the rAF loop.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Renderable, SceneUniformUpdater } from "../render/renderable.js";
import type { Sprite2DLayer } from "../sprite/sprite-2d.js";

export interface Scene2DOptions {
    clearColor?: GPUColorDict;
}

export interface Scene2DContext {
    readonly engine: EngineContext;
    clearColor: GPUColorDict;
    layers: Sprite2DLayer[];
    /** Fixed delta time in ms for deterministic animation. 0 = use real rAF delta. */
    fixedDeltaMs: number;
}

/** @internal Scene2DContext with build/render state. */
export interface Scene2DContextInternal extends Scene2DContext {
    _renderables: Renderable[];
    _updaters: SceneUniformUpdater[];
    _disposables: (() => void)[];
    _beforeRender: ((deltaMs: number) => void)[];
    _animFrameId: number;
    _renderFn: ((now: number) => void) | null;
    _disposed: boolean;
    /** Per-scene Sprite2DSceneUBO (viewport + view), shared by every Sprite2DLayer renderable.
     *  Created lazily by `ensureSprite2DSceneUBO`. */
    _sprite2dSceneUBO?: GPUBuffer;
    /** Reusable sorted-renderables scratch (refilled in place each frame to avoid per-frame allocations). */
    _sortedRenderables: Renderable[];
}

export function createScene2DContext(engine: EngineContext, opts: Scene2DOptions = {}): Scene2DContext {
    const ctx: Scene2DContextInternal = {
        engine,
        clearColor: opts.clearColor ?? { r: 0, g: 0, b: 0, a: 1 },
        layers: [],
        fixedDeltaMs: 0,
        _renderables: [],
        _updaters: [],
        _disposables: [],
        _beforeRender: [],
        _animFrameId: 0,
        _renderFn: null,
        _disposed: false,
        _sortedRenderables: [],
    };
    return ctx;
}

export function addToScene2D(scene: Scene2DContext, layer: Sprite2DLayer): void {
    const ctx = scene as Scene2DContextInternal;
    ctx.layers.push(layer);
}

export function removeFromScene2D(scene: Scene2DContext, layer: Sprite2DLayer): void {
    const ctx = scene as Scene2DContextInternal;
    const idx = ctx.layers.indexOf(layer);
    if (idx >= 0) {
        ctx.layers.splice(idx, 1);
    }
}

export function disposeScene2D(scene: Scene2DContext): void {
    const ctx = scene as Scene2DContextInternal;
    if (ctx._disposed) {
        return;
    }
    ctx._disposed = true;
    if (ctx._animFrameId) {
        cancelAnimationFrame(ctx._animFrameId);
        ctx._animFrameId = 0;
    }
    for (const fn of ctx._disposables) {
        fn();
    }
    ctx._disposables.length = 0;
    ctx._renderables.length = 0;
    ctx._updaters.length = 0;
    ctx._beforeRender.length = 0;
    ctx._sortedRenderables.length = 0;
    ctx.layers.length = 0;
}

/** Register a callback to run before each rendered frame (e.g. clip animation tick). */
export function onBeforeRender2D(scene: Scene2DContext, cb: (deltaMs: number) => void): void {
    (scene as Scene2DContextInternal)._beforeRender.push(cb);
}
