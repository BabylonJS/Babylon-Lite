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

import {
    createSceneContext,
    disposeScene,
    onBeforeRender,
    createDefaultCamera as liteCreateDefaultCamera,
    setFog,
    loadEnvironment,
    createHemisphericLight,
    addToScene,
} from "babylon-lite";
import type { SceneContext, Camera as LiteCamera, ArcRotateCamera as LiteArcRotateCamera } from "babylon-lite";

import { Color3, Color4 } from "../math/color.js";
import { unsupported } from "../error.js";
import { Observable } from "../misc/observable.js";
import type { Camera } from "../cameras/cameras.js";
import { ArcRotateCamera } from "../cameras/cameras.js";
import { StandardMaterial } from "../materials/materials.js";
import type { CubeTexture } from "../textures/textures.js";
import type { WebGPUEngine } from "../engine/engine.js";

/** Babylon.js EnvironmentHelper default skybox/ground/BRDF assets (match the Lite ports). */
const DEFAULT_SKYBOX_URL = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";
const DEFAULT_GROUND_URL = "https://assets.babylonjs.com/core/environments/backgroundGround.png";
const DEFAULT_BRDF_URL = "/brdf-lut.png";

interface DefaultEnvironmentOptions {
    createSkybox?: boolean;
    createGround?: boolean;
    skyboxSize?: number;
}

export class Scene {
    /** @internal Underlying Babylon Lite scene context. */
    public readonly _lite: SceneContext;

    /** Babylon.js fog-mode constants. */
    public static readonly FOGMODE_NONE = 0;
    public static readonly FOGMODE_EXP = 1;
    public static readonly FOGMODE_EXP2 = 2;
    public static readonly FOGMODE_LINEAR = 3;

    /** Fires before each scene render (wired to Lite's before-render hook). */
    public readonly onBeforeRenderObservable = new Observable<Scene>();
    /** Fires after each scene render. */
    public readonly onAfterRenderObservable = new Observable<Scene>();
    /** Fires once when the scene is disposed. */
    public readonly onDisposeObservable = new Observable<Scene>();

    /**
     * Babylon.js `scene.animationGroups` / `scene.animatables`. Babylon Lite drives
     * loaded animation playback through its own engine hooks, so these arrays exist
     * to satisfy the BJS-facing API (iteration, `pause()`/`stop()` calls) without
     * crashing; they are not the backing store for playback. Loaders push the
     * groups they create here.
     */
    public readonly animationGroups: unknown[] = [];
    public readonly animatables: unknown[] = [];

    private readonly _engine: WebGPUEngine;
    private _activeCamera: Camera | null = null;
    private _defaultMaterial: StandardMaterial | null = null;
    private _fogMode = 0;
    private _fogStart = 0;
    private _fogEnd = 1000;
    private _fogDensity = 0.1;
    private _fogColor = new Color3(0.2, 0.2, 0.3);
    /**
     * @internal Mesh scene-adds deferred until the engine starts. Babylon Lite
     * locks a mesh into a render group (standard vs PBR) at `addToScene` time by
     * reading its material, whereas Babylon.js code routinely creates a mesh and
     * assigns `mesh.material` a line later. Deferring the add until engine start
     * lets those assignments settle so the mesh lands in the correct group.
     */
    private readonly _pendingAdds: Array<() => void> = [];
    private _started = false;
    private _envTexture: CubeTexture | null = null;
    private _defaultEnvOptions: DefaultEnvironmentOptions | null = null;

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
     * @internal Add a mesh to the Lite scene, deferring until engine start if the
     * engine has not started yet (so a later `mesh.material = …` is captured in the
     * correct render group). After start, adds happen immediately and Lite's
     * material-swap path handles re-routing.
     */
    public _deferAdd(add: () => void): void {
        if (this._started) {
            add();
        } else {
            this._pendingAdds.push(add);
        }
    }

    /** @internal Flush deferred mesh adds. Called by the engine just before `registerScene`. */
    public _flushPendingAdds(): void {
        this._started = true;
        for (const add of this._pendingAdds) {
            add();
        }
        this._pendingAdds.length = 0;
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

    /** Babylon.js `scene.performancePriority` — accepted for parity; Babylon Lite tunes its own pipeline. */
    public performancePriority = 0;

    // ── Fog (Babylon.js `scene.fogMode/fogStart/fogEnd/fogDensity/fogColor`) ──

    public get fogMode(): number {
        return this._fogMode;
    }
    public set fogMode(value: number) {
        this._fogMode = value;
        this._applyFog();
    }

    public get fogStart(): number {
        return this._fogStart;
    }
    public set fogStart(value: number) {
        this._fogStart = value;
        this._applyFog();
    }

    public get fogEnd(): number {
        return this._fogEnd;
    }
    public set fogEnd(value: number) {
        this._fogEnd = value;
        this._applyFog();
    }

    public get fogDensity(): number {
        return this._fogDensity;
    }
    public set fogDensity(value: number) {
        this._fogDensity = value;
        this._applyFog();
    }

    public get fogColor(): Color3 {
        return this._fogColor;
    }
    public set fogColor(value: Color3) {
        this._fogColor = value;
        this._applyFog();
    }

    /** @internal Push the current fog config into the Lite scene UBO. */
    private _applyFog(): void {
        setFog(this._lite, {
            mode: this._fogMode as 0 | 1 | 2 | 3,
            density: this._fogDensity,
            start: this._fogStart,
            end: this._fogEnd,
            color: [this._fogColor.r, this._fogColor.g, this._fogColor.b],
        });
    }

    // ── Environment / IBL (Babylon.js `scene.environmentTexture` + `createDefaultEnvironment`) ──

    public get environmentTexture(): CubeTexture | null {
        return this._envTexture;
    }
    public set environmentTexture(value: CubeTexture | null) {
        this._envTexture = value;
    }

    /**
     * Babylon.js `scene.createDefaultEnvironment` — adds an IBL skybox and ground.
     * Babylon Lite performs this through `loadEnvironment` (deferred to engine start),
     * combining the environment URL recorded via `scene.environmentTexture` with
     * Babylon.js's default skybox/ground assets.
     */
    public createDefaultEnvironment(options: DefaultEnvironmentOptions = {}): { dispose(): void } {
        this._defaultEnvOptions = { createSkybox: true, createGround: true, ...options };
        return { dispose(): void {} };
    }

    /**
     * @internal Load the pending environment (IBL + skybox/ground) into the Lite
     * scene. Awaited by the engine before `registerScene` so the GPU env textures
     * exist when the scene builds.
     */
    public async _loadPendingEnvironment(): Promise<void> {
        const envUrl = this._envTexture?.url;
        if (!envUrl) {
            return;
        }
        const opts = this._defaultEnvOptions;
        await loadEnvironment(this._lite, envUrl, {
            brdfUrl: DEFAULT_BRDF_URL,
            skyboxUrl: opts?.createSkybox ? DEFAULT_SKYBOX_URL : undefined,
            skipSkybox: !opts?.createSkybox,
            groundTextureUrl: opts?.createGround ? DEFAULT_GROUND_URL : undefined,
            skipGround: !opts?.createGround,
            skyboxSize: opts?.skyboxSize ?? 1000,
        });
    }

    /** Create and activate a default arc-rotate camera framing the scene. */
    public createDefaultCamera(_createArcRotateCamera = true, _replace = true, _attachControl = false): Camera {
        const lite = liteCreateDefaultCamera(this._lite) as LiteArcRotateCamera;
        const camera = ArcRotateCamera._adopt("default camera", lite, this);
        this._activeCamera = camera;
        return camera;
    }

    /** Babylon.js `createDefaultCameraOrLight` — default framing camera plus a default hemispheric light. */
    public createDefaultCameraOrLight(createArcRotateCamera = false, replace = false, attachControl = false): void {
        this.createDefaultCamera(createArcRotateCamera, replace, attachControl);
        addToScene(this._lite, createHemisphericLight([0, 1, 0], 1.0));
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
