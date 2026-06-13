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

    public constructor(canvas: RenderCanvas, options?: ({ antialias?: boolean; adaptToDeviceRatio?: boolean } & EngineOptions) | boolean) {
        this._canvas = canvas;
        // Babylon.js's WebGPUEngine takes an options object as the second arg;
        // accept a bare boolean too (some older call sites pass `antialias`).
        this._options = typeof options === "object" ? options : undefined;
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
        void this._start();
    }

    public stopRenderLoop(): void {
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
