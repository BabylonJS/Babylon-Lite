/**
 * Babylon.js-compatible engine wrappers (`WebGPUEngine`, `Engine`).
 *
 * Babylon.js exposes a synchronous constructor plus an async `initAsync()` for
 * WebGPU. Babylon Lite acquires the GPU device in an async `createEngine()`.
 * The wrapper mirrors the Babylon.js shape: construct, then `await initAsync()`.
 *
 * Because Lite drives its own render loop through `startEngine`, `runRenderLoop`
 * is implemented by registering the callback through each scene's
 * before-render hook and kicking off Lite's loop. The startup is async under the
 * hood (Lite must register scenes before the first frame); `runRenderLoop`
 * returns immediately and rendering begins on a subsequent tick.
 */

import { createEngine, startEngine, stopEngine, resizeEngine, setEngineSize, disposeEngine, registerScene, registerSceneWithShadowSupport, onBeforeRender } from "babylon-lite";
import type { EngineContext, EngineOptions, RenderCanvas } from "babylon-lite";

import { LiteCompatError, unsupported } from "../error.js";
import type { Scene } from "../scene/scene.js";

export class WebGPUEngine {
    /** @internal The underlying Lite engine context. Populated by `initAsync()`. */
    public _lite!: EngineContext;

    private readonly _canvas: RenderCanvas;
    private readonly _options: EngineOptions | undefined;
    private readonly _scenes: Scene[] = [];
    private readonly _loopCallbacks: Array<() => void> = [];
    private _initialized = false;
    private _started = false;
    /** @internal Active `requestAnimationFrame` id for the scene-less loop, if any. */
    private _rafId: number | null = null;

    /**
     * Babylon.js `engine.useReverseDepthBuffer`. Babylon Lite owns its depth
     * configuration internally, so this is a settable no-op kept for API shape.
     */
    public useReverseDepthBuffer = false;

    /** @internal Latest per-frame delta in ms, updated by each scene's before-render hook. */
    public _lastDeltaMs = 16;

    /** @internal Last clear colour passed to `engine.clear(...)` (consumed by the scene-less sprite path). */
    public _lastClearColor: { r: number; g: number; b: number; a: number } = { r: 0, g: 0, b: 0, a: 1 };

    /** @internal Whether `engine.clear(...)` was ever called (sprite renderers overlay a scene if not). */
    public _clearRequested = false;

    /** @internal Deferred startup work (thunks) awaited before the engine starts — e.g. sprite-atlas loads. */
    private readonly _startupWork: Array<() => Promise<void>> = [];

    /**
     * @internal Deferred work awaited *after* the main scenes are registered but
     * before the engine starts — e.g. utility-layer (gizmo) registration, which
     * must happen after its gizmos are created and after the main scene is
     * registered (Babylon Lite's `registerUtilityLayer` ordering).
     */
    private readonly _lateWork: Array<() => Promise<void>> = [];

    public constructor(canvas: RenderCanvas, options?: ({ antialias?: boolean; adaptToDeviceRatio?: boolean; useLargeWorldRendering?: boolean } & EngineOptions) | boolean) {
        this._canvas = canvas;
        // Babylon.js's WebGPUEngine takes an options object as the second arg;
        // accept a bare boolean too (some older call sites pass `antialias`).
        const opts = typeof options === "object" ? { ...options } : undefined;
        // Babylon.js exposes floating-origin / large-world rendering through a
        // single `useLargeWorldRendering` flag. Babylon Lite splits it into
        // `useHighPrecisionMatrix` + `useFloatingOrigin` (the latter requires the
        // former). Translate so compat scenes that pass the BJS flag light up LWR.
        if (opts && (opts as { useLargeWorldRendering?: boolean }).useLargeWorldRendering) {
            delete (opts as { useLargeWorldRendering?: boolean }).useLargeWorldRendering;
            opts.useHighPrecisionMatrix = true;
            opts.useFloatingOrigin = true;
        }
        this._options = opts;
    }

    /** Acquire the GPU device and build the Lite engine context. */
    public async initAsync(): Promise<void> {
        if (this._initialized) {
            return;
        }
        this._lite = await createEngine(this._canvas, this._options);
        this._initialized = true;
    }

    public getRenderingCanvas(): RenderCanvas {
        return this._canvas;
    }

    /**
     * Babylon.js `engine.getDeltaTime()` — milliseconds elapsed since the previous
     * frame. Updated from each scene's Lite before-render hook (which receives the
     * frame delta); defaults to ~16ms before the first frame.
     */
    public getDeltaTime(): number {
        return this._lastDeltaMs;
    }

    /**
     * Babylon.js `engine.isNDCHalfZRange`. WebGPU's clip space uses a `[0, 1]`
     * depth range, so this is always `true` under Babylon Lite.
     */
    public get isNDCHalfZRange(): boolean {
        return true;
    }

    /**
     * Babylon.js `engine.clear(color?, backBuffer?, depth?, stencil?)`. Babylon
     * Lite owns clearing through its render contexts (scenes / sprite renderers),
     * so this records the requested clear colour (used by the scene-less sprite
     * renderer path) and is otherwise a no-op.
     */
    public clear(color?: { r: number; g: number; b: number; a: number }, _backBuffer?: boolean, _depth?: boolean, _stencil?: boolean): void {
        this._clearRequested = true;
        if (color) {
            this._lastClearColor = { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 };
        }
    }

    /** @internal Register deferred startup work (a thunk) awaited before the engine starts. */
    public _registerStartupWork(work: () => Promise<void>): void {
        this._startupWork.push(work);
    }

    /** @internal Register deferred work awaited after the main scenes register but before the engine starts. */
    public _registerLateWork(work: () => Promise<void>): void {
        this._lateWork.push(work);
    }

    /** @internal Scenes register themselves on construction. */
    public _registerScene(scene: Scene): void {
        this._scenes.push(scene);
        // Wire already-registered loop callbacks into the new scene.
        for (const cb of this._loopCallbacks) {
            onBeforeRender(scene._lite, () => cb());
        }
    }

    public runRenderLoop(callback: () => void): void {
        this._ensureInitialized("runRenderLoop");
        this._loopCallbacks.push(callback);
        for (const scene of this._scenes) {
            onBeforeRender(scene._lite, () => callback());
        }
        void this._start().then(() => {
            // Scene-less render loops (e.g. the `SpriteRenderer` 2D path) have no
            // scene before-render hook to drive the callback. Run them on a
            // `requestAnimationFrame` loop so per-frame work (e.g. sprite-sheet
            // animation that mutates `cellIndex` each tick) actually advances.
            // Babylon Lite's own render loop draws the registered sprite renderer;
            // we just need to push the updated sprite data before each frame.
            if (this._scenes.length === 0 && this._rafId === null && typeof requestAnimationFrame === "function") {
                const tick = (): void => {
                    for (const cb of this._loopCallbacks) {
                        cb();
                    }
                    this._rafId = requestAnimationFrame(tick);
                };
                this._rafId = requestAnimationFrame(tick);
            }
        });
    }

    public stopRenderLoop(): void {
        if (this._rafId !== null && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._initialized) {
            stopEngine(this._lite);
        }
    }

    public resize(): void {
        this._ensureInitialized("resize");
        resizeEngine(this._lite);
    }

    public setSize(width: number, height: number): void {
        this._ensureInitialized("setSize");
        setEngineSize(this._lite, width, height);
    }

    public dispose(): void {
        if (this._rafId !== null && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._initialized) {
            disposeEngine(this._lite);
        }
    }

    /** Babylon.js manual frame-pump entry point — unsupported (Lite's frame graph owns the frame). */
    public beginFrame(): never {
        return unsupported("WebGPUEngine.beginFrame", "Babylon Lite's frame graph owns the frame loop; drive rendering with `runRenderLoop`.");
    }

    /** Babylon.js manual frame-pump exit point — unsupported (Lite's frame graph owns the frame). */
    public endFrame(): never {
        return unsupported("WebGPUEngine.endFrame", "Babylon Lite's frame graph owns the frame loop; drive rendering with `runRenderLoop`.");
    }

    private async _start(): Promise<void> {
        if (this._started) {
            return;
        }
        this._started = true;
        // Run deferred startup work (e.g. sprite-atlas loads) first, so any
        // resources a render context needs exist before the first frame.
        if (this._startupWork.length > 0) {
            await Promise.all(this._startupWork.map((w) => w()));
            this._startupWork.length = 0;
        }
        for (const scene of this._scenes) {
            await scene._awaitPendingTextures();
            scene._flushPendingAdds();
            await scene._loadPendingEnvironment();
            scene._buildShadowGenerators();
            if (scene._hasShadows()) {
                await registerSceneWithShadowSupport(scene._lite);
            } else {
                await registerScene(scene._lite);
            }
        }
        // Late work runs after the main scenes are registered (e.g. utility-layer
        // gizmo registration, which Babylon Lite registers after the main scene).
        if (this._lateWork.length > 0) {
            await Promise.all(this._lateWork.map((w) => w()));
            this._lateWork.length = 0;
        }
        await startEngine(this._lite);
    }

    private _ensureInitialized(api: string): void {
        if (!this._initialized) {
            throw new LiteCompatError(`WebGPUEngine.${api}`, "Call `await engine.initAsync()` before using the engine.");
        }
    }
}

/**
 * `Engine` is Babylon.js's WebGL/WebGPU engine. Babylon Lite is WebGPU-only, so
 * this is an alias for {@link WebGPUEngine} that fails loudly if WebGPU is
 * unavailable (surfaced through `initAsync`).
 */
export class Engine extends WebGPUEngine {}
