/**
 * Babylon.js-compatible `Scene` implemented over a Babylon Lite `SceneContext`.
 *
 * The wrapper owns a Lite `SceneContext` (`_lite`) and proxies the common
 * Babylon.js scene surface: `clearColor`, `activeCamera`, the before/after-render
 * observables, default camera creation, and disposal. Entities created by the
 * compat light/camera/mesh wrappers register themselves against `_lite`.
 *
 * `scene.render()` is a no-op: Babylon Lite drives rendering through the engine's
 * loop (`runRenderLoop` / `startEngine`). Manual single-frame rendering is not
 * supported in this compat layer.
 */

import { createSceneContext, disposeScene, onBeforeRender, createDefaultCamera as liteCreateDefaultCamera } from "babylon-lite";
import type { SceneContext, Camera as LiteCamera, ArcRotateCamera as LiteArcRotateCamera } from "babylon-lite";

import { Color4 } from "../math/color.js";
import { unsupported } from "../error.js";
import { Observable } from "../misc/observable.js";
import type { Camera } from "../cameras/cameras.js";
import { ArcRotateCamera } from "../cameras/cameras.js";
import { StandardMaterial } from "../materials/materials.js";
import type { WebGPUEngine } from "../engine/engine.js";

export class Scene {
    /** @internal Underlying Babylon Lite scene context. */
    public readonly _lite: SceneContext;

    /** Fires before each scene render (wired to Lite's before-render hook). */
    public readonly onBeforeRenderObservable = new Observable<Scene>();
    /** Fires after each scene render. */
    public readonly onAfterRenderObservable = new Observable<Scene>();
    /** Fires once when the scene is disposed. */
    public readonly onDisposeObservable = new Observable<Scene>();

    private readonly _engine: WebGPUEngine;
    private _activeCamera: Camera | null = null;
    private _defaultMaterial: StandardMaterial | null = null;

    public constructor(engine: WebGPUEngine) {
        this._engine = engine;
        this._lite = createSceneContext(engine._lite);
        // Babylon Lite exposes a before-render hook but no after-render hook. We
        // fire `onBeforeRenderObservable` on each tick, and approximate
        // `onAfterRenderObservable` by firing it at the start of the *next* tick
        // (i.e. after the previous frame has rendered). `addOnce` after-render
        // listeners therefore resolve one frame later than they would in BJS.
        let renderedAFrame = false;
        onBeforeRender(this._lite, () => {
            if (renderedAFrame) {
                this.onAfterRenderObservable.notifyObservers(this);
            }
            renderedAFrame = true;
            this.onBeforeRenderObservable.notifyObservers(this);
        });
        engine._registerScene(this);
    }

    public getEngine(): WebGPUEngine {
        return this._engine;
    }

    /**
     * Babylon.js `scene.defaultMaterial` — a shared `StandardMaterial` applied to
     * meshes that have no material assigned. Babylon Lite requires every mesh to
     * carry a material to render, so the mesh wrappers assign this lazily-created
     * default; reading it (or assigning a replacement) matches Babylon.js.
     */
    public get defaultMaterial(): StandardMaterial {
        if (!this._defaultMaterial) {
            this._defaultMaterial = new StandardMaterial("default material", this);
        }
        return this._defaultMaterial;
    }
    public set defaultMaterial(value: StandardMaterial) {
        this._defaultMaterial = value;
    }

    public get clearColor(): Color4 {
        const c = this._lite.clearColor;
        return new Color4(c.r, c.g, c.b, c.a ?? 1);
    }
    public set clearColor(value: Color4) {
        this._lite.clearColor = { r: value.r, g: value.g, b: value.b, a: value.a };
    }

    public get activeCamera(): Camera | null {
        return this._activeCamera;
    }
    public set activeCamera(camera: Camera | null) {
        this._activeCamera = camera;
        this._lite.camera = (camera?._lite as LiteCamera | undefined) ?? null;
    }

    /** Image-processing exposure proxy (Babylon.js `imageProcessingConfiguration.exposure`). */
    public get imageProcessingConfiguration(): { exposure: number; contrast: number; toneMappingEnabled: boolean } {
        return this._lite.imageProcessing;
    }

    /** Create and activate a default arc-rotate camera framing the scene. */
    public createDefaultCamera(_createArcRotateCamera = true, _replace = true, _attachControl = false): Camera {
        const lite = liteCreateDefaultCamera(this._lite) as LiteArcRotateCamera;
        const camera = ArcRotateCamera._adopt("default camera", lite, this);
        this._activeCamera = camera;
        return camera;
    }

    /** Babylon.js render hook. No-op under Babylon Lite's engine-driven loop. */
    public render(): void {
        // Intentionally empty: Lite renders registered scenes via startEngine.
    }

    /**
     * Babylon.js readiness gate. Babylon Lite builds its scene synchronously and
     * defers GPU work into `registerScene`/`startEngine` (driven by the engine's
     * render loop), so there is nothing to await here — resolve immediately.
     */
    public whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }

    /** Babylon.js synchronous readiness check — always ready in the compat layer. */
    public isReady(): boolean {
        return true;
    }

    /** Synchronous CPU picking — unsupported. Babylon Lite uses async GPU picking. */
    public pick(): never {
        return unsupported(
            "Scene.pick",
            "Babylon Lite uses asynchronous GPU picking. Use the compat `GPUPicker` class (Babylon.js parity) or the native `createGpuPicker` + `pickAsync` API."
        );
    }

    /** Synchronous ray picking — unsupported. */
    public pickWithRay(): never {
        return unsupported("Scene.pickWithRay", "Synchronous CPU ray-mesh intersection is not implemented in Babylon Lite.");
    }

    /** Lookup by name — needs a public Lite scene accessor that does not yet exist. */
    public getMeshByName(): never {
        return unsupported("Scene.getMeshByName", "Babylon Lite does not expose a public scene-mesh registry yet. Track meshes you create yourself.");
    }

    /** Babylon.js convenience animation starter — not yet wrapped. */
    public beginAnimation(): never {
        return unsupported("Scene.beginAnimation", "Not yet wrapped. Use the native Babylon Lite property-animation API (`createPropertyAnimationGroup`).");
    }

    public dispose(): void {
        this.onDisposeObservable.notifyObservers(this);
        disposeScene(this._lite);
    }
}
