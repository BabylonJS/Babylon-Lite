/**
 * Babylon.js-compatible engine wrappers.
 *
 * The class hierarchy mirrors Babylon.js exactly: `AbstractEngine` is the base,
 * `ThinEngine extends AbstractEngine`, `Engine extends ThinEngine`, and
 * `WebGPUEngine extends AbstractEngine` (so `Engine` and `WebGPUEngine` are
 * siblings, as in Babylon.js). All shared behaviour lives on `AbstractEngine`;
 * because Babylon Lite is WebGPU-only, every concrete engine is backed by the
 * same Lite WebGPU context, so `new Engine(...)` and `new WebGPUEngine(...)`
 * behave identically.
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
import { Observable } from "../misc/observable.js";
import type { Scene } from "../scene/scene.js";

export abstract class AbstractEngine {
    /** @internal The underlying Lite engine context. Populated by `initAsync()`. */
    public _lite!: EngineContext;

    /**
     * @internal Whether this engine has no GPU device (a {@link NullEngine}). Headless
     * engines drive a pure-JS animation/observable loop instead of Babylon Lite's
     * GPU render loop, so the compat `Scene` skips its Lite scene-context setup.
     */
    public _headless = false;

    protected readonly _canvas: RenderCanvas;
    private readonly _options: EngineOptions | undefined;
    protected readonly _scenes: Scene[] = [];
    protected readonly _loopCallbacks: Array<() => void> = [];
    protected _initialized = false;
    private _started = false;
    /** @internal Active `requestAnimationFrame` id for the scene-less loop, if any. */
    protected _rafId: number | null = null;

    /**
     * Babylon.js `engine.useReverseDepthBuffer`. Babylon Lite owns its depth
     * configuration internally, so this is a settable no-op kept for API shape.
     */
    public useReverseDepthBuffer = false;

    /** Babylon.js `engine.onResizeObservable` — fires after `resize()` / `setSize()`. */
    public readonly onResizeObservable = new Observable<AbstractEngine>();

    /** @internal Babylon.js hardware-scaling level. Babylon Lite manages device-pixel-ratio itself; stored for parity. */
    private _hardwareScalingLevel = 1;

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

    /** Babylon.js `engine.isWebGPU` — Babylon Lite is WebGPU-only, so always `true`. */
    public get isWebGPU(): boolean {
        return true;
    }

    /**
     * Babylon.js `engine.getCaps()` — engine capability flags. Only the
     * compressed-texture-format flags ported scenes branch on are derived (from the
     * Lite WebGPU device's enabled features); the rest report Babylon Lite's fixed
     * WebGPU baseline. A headless `NullEngine` has no device, so all flags are off.
     */
    public getCaps(): Record<string, unknown> {
        const device = (this._lite as { _device?: { features?: { has(name: string): boolean } } } | undefined)?._device;
        const has = (name: string): boolean => !!device?.features?.has(name);
        return {
            astc: has("texture-compression-astc"),
            s3tc: has("texture-compression-bc"),
            bc7: has("texture-compression-bc"),
            etc2: has("texture-compression-etc2"),
            // ETC1 is a distinct format family with no WebGPU feature flag — never
            // report it as available (an ETC2 device can decode ETC1 content, but
            // advertising `etc1` can steer upstream selection to a non-existent path).
            etc1: false,
            pvrtc: false,
            // WebGPU baseline capabilities Babylon Lite always provides.
            textureFloat: true,
            textureHalfFloat: true,
            textureFloatLinearFiltering: true,
            maxTextureSize: 8192,
            instancedArrays: true,
            uintIndices: true,
        };
    }

    /** Babylon.js `engine.scenes` — every scene created against this engine. */
    public get scenes(): Scene[] {
        return this._scenes;
    }

    /** Babylon.js `engine.getRenderWidth()` — backing render-target width in pixels. */
    public getRenderWidth(): number {
        return (this._canvas as { width?: number }).width ?? 0;
    }

    /** Babylon.js `engine.getRenderHeight()` — backing render-target height in pixels. */
    public getRenderHeight(): number {
        return (this._canvas as { height?: number }).height ?? 0;
    }

    /** Babylon.js `engine.getScreenAspectRatio()` — render-target width / height. */
    public getScreenAspectRatio(): number {
        const h = this.getRenderHeight();
        return h !== 0 ? this.getRenderWidth() / h : 1;
    }

    /**
     * Babylon.js `engine.getAspectRatio(camera?, useScreen?)`. Babylon Lite renders
     * each scene through a single full-canvas viewport, so the camera viewport does
     * not subdivide the surface — this is the screen aspect ratio.
     */
    public getAspectRatio(_camera?: unknown, _useScreen?: boolean): number {
        return this.getScreenAspectRatio();
    }

    /** Babylon.js `engine.getFps()` — frames-per-second estimate from the last frame delta. */
    public getFps(): number {
        return this._lastDeltaMs > 0 ? 1000 / this._lastDeltaMs : 60;
    }

    /**
     * Babylon.js `engine.getHardwareScalingLevel()`. Babylon Lite manages its own
     * device-pixel-ratio scaling, so this returns the stored parity value.
     */
    public getHardwareScalingLevel(): number {
        return this._hardwareScalingLevel;
    }

    /** Babylon.js `engine.setHardwareScalingLevel(level)` — stored for parity (Lite self-manages DPR). */
    public setHardwareScalingLevel(level: number): void {
        this._hardwareScalingLevel = level;
    }

    /** Babylon.js `engine.getRenderingCanvasClientRect()` — the canvas client rect, or `null` for offscreen canvases. */
    public getRenderingCanvasClientRect(): { x: number; y: number; width: number; height: number } | null {
        const c = this._canvas as { getBoundingClientRect?: () => { x: number; y: number; width: number; height: number } };
        return typeof c.getBoundingClientRect === "function" ? c.getBoundingClientRect() : null;
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
        this.onResizeObservable.notifyObservers(this);
    }

    public setSize(width: number, height: number): void {
        this._ensureInitialized("setSize");
        setEngineSize(this._lite, width, height);
        this.onResizeObservable.notifyObservers(this);
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
            // Build shadow generators first so NME materials can sample them at parse
            // time (Babylon Lite wires shadow receivers into the NME graph on parse).
            scene._buildShadowGenerators();
            await scene._parseNodeMaterials();
            await scene._awaitPendingTextures();
            scene._bakeGroundUvs();
            scene._flushPendingAdds();
            scene._buildMorphTargets();
            await scene._loadPendingEnvironment();
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
            throw new LiteCompatError(`${this.constructor.name}.${api}`, "Call `await engine.initAsync()` before using the engine.");
        }
    }
}

/**
 * Babylon.js's headless/abstract WebGL engine layer. In Babylon.js
 * `ThinEngine extends AbstractEngine` and is the lightweight (no scene-graph)
 * engine; the compat layer carries no extra behaviour over {@link AbstractEngine}
 * (everything is WebGPU-backed), so this exists purely to reproduce the class
 * name and inheritance chain.
 */
export class ThinEngine extends AbstractEngine {}

/**
 * Babylon.js's full WebGL engine. In Babylon.js `Engine extends ThinEngine`
 * (sibling to {@link WebGPUEngine}, both rooted at {@link AbstractEngine}).
 * Babylon Lite is WebGPU-only, so a compat `Engine` is still backed by the same
 * Lite WebGPU context; this class exists to mirror Babylon.js's name + hierarchy.
 */
export class Engine extends ThinEngine {}

/**
 * Babylon.js's WebGPU engine. In Babylon.js `WebGPUEngine extends AbstractEngine`
 * (sibling to {@link Engine}). This is the natural engine for the compat layer
 * since Babylon Lite is WebGPU-only.
 */
export class WebGPUEngine extends AbstractEngine {}

/** A degenerate canvas stand-in for the deviceless {@link NullEngine}. */
const NULL_CANVAS = { width: 0, height: 0 } as unknown as RenderCanvas;

/**
 * Babylon.js's `NullEngine` — a headless engine with no GPU device, used to run
 * scene logic (animations, observables, frame timing) without rendering. Babylon
 * Lite has no headless context, so the compat `NullEngine` builds nothing on the
 * GPU: it drives a pure-JS `requestAnimationFrame` loop that advances each scene's
 * CPU animations and fires its before/after-render observables. Scenes constructed
 * against it skip the Lite scene-context build (see `Scene`'s headless branch), so
 * only the deviceless surface (CPU animations, manual 2D-canvas drawing, etc.)
 * works — there is no WebGPU rendering. Extends {@link WebGPUEngine} so it is
 * accepted everywhere a compat engine is (e.g. `new Scene(engine)`).
 */
export class NullEngine extends WebGPUEngine {
    public constructor() {
        super(NULL_CANVAS);
        this._headless = true;
        // No GPU device to acquire — usable immediately, no `initAsync()` needed.
        this._initialized = true;
    }

    /** No GPU device to acquire. */
    public override async initAsync(): Promise<void> {
        // Headless: nothing to initialise.
    }

    /**
     * Drive a pure-JS frame loop: each tick advances every registered scene's CPU
     * animations + render observables, then runs the user callback(s). No GPU work.
     */
    public override runRenderLoop(callback: () => void): void {
        this._loopCallbacks.push(callback);
        if (this._rafId !== null || typeof requestAnimationFrame !== "function") {
            return;
        }
        const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
        let last = now();
        const tick = (): void => {
            const current = now();
            const deltaMs = current - last;
            last = current;
            for (const scene of this._scenes) {
                scene._tick(deltaMs);
            }
            for (const cb of this._loopCallbacks) {
                cb();
            }
            this._rafId = requestAnimationFrame(tick);
        };
        this._rafId = requestAnimationFrame(tick);
    }

    /** @internal Track the scene for the headless tick loop (no Lite before-render wiring). */
    public override _registerScene(scene: Scene): void {
        if (!this._scenes.includes(scene)) {
            this._scenes.push(scene);
        }
    }
}
