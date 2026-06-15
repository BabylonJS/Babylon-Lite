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
    createAnimationManager,
    addAnimationGroup,
    enableAnimationBlending,
    updateAnimationManager,
} from "babylon-lite";
import { loadDdsEnvironment } from "babylon-lite/loader-env/load-dds-env";
import type { SceneContext, Camera as LiteCamera, ArcRotateCamera as LiteArcRotateCamera, AnimationManager } from "babylon-lite";

import { Color3, Color4 } from "../math/color.js";
import { unsupported } from "../error.js";
import { Observable } from "../misc/observable.js";
import type { Camera } from "../cameras/cameras.js";
import { ArcRotateCamera } from "../cameras/cameras.js";
import type { TransformNode } from "../meshes/meshes.js";
import { StandardMaterial } from "../materials/materials.js";
import { Animatable } from "../animations/animation.js";
import type { Animation } from "../animations/animation.js";
import { AnimationGroup } from "../animations/animation.js";
import type { CubeTexture } from "../textures/textures.js";
import type { WebGPUEngine } from "../engine/engine.js";

/** Babylon.js EnvironmentHelper default skybox/ground/BRDF assets (match the Lite ports). */
const DEFAULT_SKYBOX_URL = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";
const DEFAULT_GROUND_URL = "https://assets.babylonjs.com/core/environments/backgroundGround.png";
const DEFAULT_BRDF_URL = "/brdf-lut.png";
/** Babylon.js `createDefaultEnvironment` IBL fallback when no `environmentTexture` is set. */
const DEFAULT_ENV_URL = "https://assets.babylonjs.com/environments/environmentSpecular.env";

interface DefaultEnvironmentOptions {
    createSkybox?: boolean;
    createGround?: boolean;
    skyboxSize?: number;
    /** Babylon.js EnvironmentHelper: set up tone mapping / exposure / contrast (default true). */
    setupImageProcessing?: boolean;
    /** Babylon.js EnvironmentHelper camera exposure (default 0.8). */
    cameraExposure?: number;
    /** Babylon.js EnvironmentHelper camera contrast (default 1.2). */
    cameraContrast?: number;
    /** Babylon.js EnvironmentHelper tone-mapping toggle (default true). */
    toneMappingEnabled?: boolean;
    /** @internal When set, the skybox is the environment texture itself (Babylon.js `createDefaultSkybox`). */
    skyboxFromEnv?: boolean;
    /** @internal Apply EnvironmentHelper image processing (only set by `createDefaultEnvironment`). */
    applyImageProcessing?: boolean;
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
    /** Fires before animations are evaluated each frame (used by ported cross-fade drivers). */
    public readonly onBeforeAnimationsObservable = new Observable<Scene>();
    /** Fires after each scene render. */
    public readonly onAfterRenderObservable = new Observable<Scene>();
    /** Fires once when the scene is disposed. */
    public readonly onDisposeObservable = new Observable<Scene>();

    /**
     * Babylon.js `scene.animationGroups` / `scene.animatables`. Loaded glTF /
     * `.babylon` animation clips live on the Lite scene; `animationGroups` returns
     * BJS-shaped `AnimationGroup`s over them (so scenes can `goToFrame`/`pause`/`stop`
     * to freeze a model at a deterministic frame). `animatables` surfaces the running
     * CPU `Animatable`s started via `beginDirectAnimation`.
     */
    public get animationGroups(): AnimationGroup[] {
        const liteGroups = this._lite.animationGroups ?? [];
        return liteGroups.map((g) => {
            let wrapper = this._animationGroupCache.get(g);
            if (!wrapper) {
                wrapper = AnimationGroup._fromLite(g, this._engine._lite, this);
                this._animationGroupCache.set(g, wrapper);
            }
            return wrapper;
        });
    }

    /**
     * Babylon.js `scene.meshes`. Babylon Lite does not expose a public scene-mesh
     * registry, so this tracks the meshes the compat layer creates against a scene
     * which need lookup (currently Gaussian-Splatting meshes surfaced through the
     * loader). Other primitives register with the Lite scene directly.
     */
    public get meshes(): TransformNode[] {
        return this._trackedMeshes;
    }

    /** @internal Track a compat mesh so it appears in `scene.meshes`. */
    public _registerMesh(mesh: TransformNode): void {
        if (!this._trackedMeshes.includes(mesh)) {
            this._trackedMeshes.push(mesh);
        }
    }

    public get animatables(): Animatable[] {
        return this._runningAnimatables;
    }

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
    private readonly _shadowGenerators: Array<{ _build(engine: import("babylon-lite").EngineContext): void; _liteGen?: unknown }> = [];
    private readonly _pendingTextures: Array<Promise<void>> = [];
    private readonly _pendingGroundBakes: Array<() => void> = [];
    private readonly _runningAnimatables: Animatable[] = [];
    private readonly _animationGroupCache = new WeakMap<object, AnimationGroup>();
    /** @internal Structural `AnimationGroup`s stepped + weight-blended each frame. */
    private readonly _structuralGroups: AnimationGroup[] = [];
    /** @internal Lite manager that weight/additive-blends loaded glTF groups (lazily created). */
    private _blendManager: AnimationManager | null = null;
    /** @internal Compat meshes surfaced through `scene.meshes` (e.g. Gaussian-Splatting). */
    private readonly _trackedMeshes: TransformNode[] = [];
    /** @internal `NodeMaterial`s whose async parse the engine drives after shadow generators are built. */
    private readonly _nodeMaterials: Array<{ _parse(engine: import("babylon-lite").EngineContext, shadowGenerators: readonly unknown[]): Promise<void> }> = [];

    public constructor(engine: WebGPUEngine) {
        this._engine = engine;
        this._lite = createSceneContext(engine._lite);
        // Babylon Lite exposes a before-render hook but no after-render hook. We
        // fire `onBeforeRenderObservable` on each tick, and approximate
        // `onAfterRenderObservable` by firing it at the start of the *next* tick
        // (i.e. after the previous frame has rendered). `addOnce` after-render
        // listeners therefore resolve one frame later than they would in BJS.
        let renderedAFrame = false;
        onBeforeRender(this._lite, (deltaMs: number) => {
            // Record the frame delta so `engine.getDeltaTime()` (read inside
            // before-render observers) reflects the current frame.
            this._engine._lastDeltaMs = deltaMs;
            this.onBeforeAnimationsObservable.notifyObservers(this);
            if (this._blendManager) {
                updateAnimationManager(this._blendManager, deltaMs);
            }
            for (const a of this._runningAnimatables) {
                a._tick(deltaMs);
            }
            if (this._structuralGroups.length > 0) {
                for (const g of this._structuralGroups) {
                    g._advanceStructural(deltaMs);
                }
                AnimationGroup._blendStructuralGroups(this._structuralGroups);
            }
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

    /** @internal Register a compat `ShadowGenerator` to be built at engine start. */
    public _registerShadowGenerator(gen: { _build(engine: import("babylon-lite").EngineContext): void }): void {
        this._shadowGenerators.push(gen);
    }

    /** @internal Track an async texture load so the engine can await it before building the scene. */
    public _trackTextureLoad(promise: Promise<void>): void {
        this._pendingTextures.push(promise);
    }

    /** @internal Await all in-flight texture loads (so material maps are GPU-ready at build). */
    public async _awaitPendingTextures(): Promise<void> {
        if (this._pendingTextures.length > 0) {
            await Promise.all(this._pendingTextures);
            this._pendingTextures.length = 0;
        }
    }

    /**
     * @internal Register a deferred ground-UV bake (for `CreateGroundFromHeightMap` with a
     * PBR `albedoTexture` whose `uScale`/`vScale` tiling must be baked into the geometry,
     * since Babylon Lite's PBR pipeline has no material-level UV scale). Run by
     * {@link _bakeGroundUvs} after textures load, so the material's `albedoTexture` (assigned
     * by user code after the heightmap resolves) is in place and its tiling is read correctly.
     */
    public _registerGroundUvBake(bake: () => void): void {
        this._pendingGroundBakes.push(bake);
    }

    /** @internal Run deferred ground-UV bakes. Called by the engine after `_awaitPendingTextures`. */
    public _bakeGroundUvs(): void {
        for (const bake of this._pendingGroundBakes) {
            bake();
        }
        this._pendingGroundBakes.length = 0;
    }

    /** @internal Whether any shadow generator is present (engine uses shadow-aware registration). */
    public _hasShadows(): boolean {
        return this._shadowGenerators.length > 0;
    }

    /** @internal Build all registered shadow generators. Called after meshes are added. */
    public _buildShadowGenerators(): void {
        const engine = this._engine._lite;
        for (const gen of this._shadowGenerators) {
            gen._build(engine);
        }
    }

    /** @internal Register a `NodeMaterial` whose parse the engine drives after shadow build. */
    public _registerNodeMaterial(material: { _parse(engine: import("babylon-lite").EngineContext, shadowGenerators: readonly unknown[]): Promise<void> }): void {
        this._nodeMaterials.push(material);
    }

    /**
     * @internal Parse all registered `NodeMaterial`s, passing the scene's built Lite
     * shadow generators so NME shadow-receiver blocks sample them (Babylon.js wires
     * shadows into the scene globally; Babylon Lite takes them at NME parse time).
     * Must run after `_buildShadowGenerators` so the Lite generators exist.
     */
    public async _parseNodeMaterials(): Promise<void> {
        if (this._nodeMaterials.length === 0) {
            return;
        }
        const engine = this._engine._lite;
        const liteGens = this._shadowGenerators.map((g) => g._liteGen).filter((g): g is unknown => g !== undefined);
        await Promise.all(this._nodeMaterials.map((m) => m._parse(engine, liteGens)));
        this._nodeMaterials.length = 0;
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

    /** Babylon.js `scene.attachControl` — camera input is attached per-camera in the compat layer; no-op. */
    public attachControl(_attachUp?: boolean, _attachDown?: boolean, _attachMove?: boolean): void {
        // Camera control is wired through `camera.attachControl(canvas)`.
    }

    /** Babylon.js `scene.detachControl` — no-op (see {@link attachControl}). */
    public detachControl(): void {
        // No-op.
    }

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
        this._defaultEnvOptions = {
            createSkybox: true,
            createGround: true,
            ...options,
            // Babylon.js EnvironmentHelper sets up image processing by default.
            applyImageProcessing: options.setupImageProcessing !== false,
        };
        return { dispose(): void {} };
    }

    /**
     * Babylon.js `scene.createDefaultSkybox(texture, pbr?, scale?, blur?, setGlobalEnv?)` —
     * adds a skybox built from the given environment texture. Babylon Lite reuses the
     * loaded `.env` specular cubemap as an HDR skybox, so this records the env URL (if
     * not already set) and flags a skybox-from-environment load at engine start.
     */
    public createDefaultSkybox(texture?: CubeTexture, _pbr?: boolean, scale?: number, _blur?: number, _setGlobalEnv?: boolean): { dispose(): void } {
        if (texture) {
            this._envTexture = texture;
        }
        this._defaultEnvOptions = {
            ...(this._defaultEnvOptions ?? {}),
            createSkybox: true,
            createGround: false,
            skyboxFromEnv: true,
            ...(scale !== undefined ? { skyboxSize: scale } : {}),
        };
        return { dispose(): void {} };
    }

    /**
     * @internal Load the pending environment (IBL + skybox/ground) into the Lite
     * scene. Awaited by the engine before `registerScene` so the GPU env textures
     * exist when the scene builds.
     */
    public async _loadPendingEnvironment(): Promise<void> {
        // Babylon.js `createDefaultEnvironment` lights the scene from a built-in
        // environment even when no `environmentTexture` is assigned; fall back to
        // the default specular env so IBL-only scenes are lit correctly.
        const envUrl = this._envTexture?.url ?? (this._defaultEnvOptions ? DEFAULT_ENV_URL : undefined);
        if (!envUrl) {
            return;
        }
        const opts = this._defaultEnvOptions;
        const skyboxUrl = opts?.skyboxFromEnv ? envUrl : opts?.createSkybox ? DEFAULT_SKYBOX_URL : undefined;
        // Babylon.js `scene.environmentTexture = …` / `CubeTexture.CreateFromPrefilteredData`
        // does NOT change image processing — tone mapping stays at the scene's current
        // value (Babylon.js default: off). Babylon Lite's `loadEnvironment`/`loadDdsEnvironment`,
        // however, force tone mapping on (exposure 0.8 / contrast 1.2). That side effect is
        // wrong for ported code that only assigns `environmentTexture` (e.g. NME scenes), but it
        // happens to mirror what Babylon.js's `createDefaultEnvironment` (EnvironmentHelper) does.
        // Snapshot the scene's image-processing state and restore it after the env load so the
        // side effect is invisible; if `createDefaultEnvironment` was used we re-apply the
        // EnvironmentHelper image processing explicitly below — matching Babylon.js semantics.
        const ip = this._lite.imageProcessing;
        const ipSnapshot = { exposure: ip.exposure, contrast: ip.contrast, toneMappingEnabled: ip.toneMappingEnabled };
        // Babylon.js `CubeTexture.CreateFromPrefilteredData` accepts both `.env`
        // and `.dds` prefiltered environments. Babylon Lite splits these into two
        // loaders: `loadEnvironment` (`.env`) and `loadDdsEnvironment` (`.dds`).
        if (envUrl.toLowerCase().endsWith(".dds")) {
            await loadDdsEnvironment(this._lite, envUrl, {
                brdfUrl: DEFAULT_BRDF_URL,
                skipSkybox: !opts?.createSkybox,
                skipGround: !opts?.createGround,
            });
        } else {
            await loadEnvironment(this._lite, envUrl, {
                brdfUrl: DEFAULT_BRDF_URL,
                skyboxUrl,
                skipSkybox: !opts?.createSkybox,
                groundTextureUrl: opts?.createGround ? DEFAULT_GROUND_URL : undefined,
                skipGround: !opts?.createGround,
                skyboxSize: opts?.skyboxSize ?? 1000,
            });
        }
        ip.exposure = ipSnapshot.exposure;
        ip.contrast = ipSnapshot.contrast;
        ip.toneMappingEnabled = ipSnapshot.toneMappingEnabled;
        // Babylon.js EnvironmentHelper (`createDefaultEnvironment`) sets up image processing
        // by default: tone mapping on with exposure 0.8 / contrast 1.2 (all overridable). Apply
        // it here so `createDefaultEnvironment` scenes (e.g. PBR sphere grids) keep their tone
        // mapping while plain `environmentTexture` scenes (e.g. NME) do not.
        if (opts?.applyImageProcessing) {
            ip.toneMappingEnabled = opts.toneMappingEnabled ?? true;
            ip.exposure = opts.cameraExposure ?? 0.8;
            ip.contrast = opts.cameraContrast ?? 1.2;
        }
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

    /**
     * Babylon.js `scene.beginDirectAnimation(target, animations, from, to, loop, speedRatio?)`.
     * Drives the given `Animation`s on the CPU each frame, writing onto the target's
     * (dotted) property path. Returns an `Animatable` with `goToFrame`/`pause`/`stop`.
     */
    public beginDirectAnimation(target: unknown, animations: Animation[], from: number, to: number, loop = false, speedRatio = 1): Animatable {
        const animatable = new Animatable(target, animations, from, to, loop, speedRatio);
        this._runningAnimatables.push(animatable);
        return animatable;
    }

    /** @internal Register a structural `AnimationGroup` to be stepped + blended each frame. */
    public _registerStructuralGroup(group: AnimationGroup): void {
        if (!this._structuralGroups.includes(group)) {
            this._structuralGroups.push(group);
        }
    }

    /** @internal Re-run weighted blending across all structural groups (after a seek/weight change). */
    public _recomputeStructuralBlends(): void {
        AnimationGroup._blendStructuralGroups(this._structuralGroups);
    }

    /**
     * @internal Route the scene's loaded Lite animation groups through a
     * scene-owned `AnimationManager` with weighted/additive blending enabled.
     *
     * Babylon.js treats the scene as an implicit animation mixer, so any loaded
     * group whose weight ≠ 1 (or that is made additive) must blend with its
     * siblings on the shared skeleton. Babylon Lite makes the manager explicit and
     * blending opt-in (`enableAnimationBlending`). When a glTF container is added,
     * Lite installs a per-group last-writer-wins tick (scene-core `addToScene`); we
     * detach each group's controller (`_ctrl`) so that tick skips them and the
     * weighted mixer — which drives groups via `_gltfMixer`, not `_ctrl` — owns the
     * pose instead. Idempotent.
     */
    public _enableLoadedBlend(): void {
        const liteGroups = this._lite.animationGroups ?? [];
        if (liteGroups.length === 0) {
            return;
        }
        if (!this._blendManager) {
            this._blendManager = createAnimationManager({ engine: this._engine._lite });
            enableAnimationBlending(this._blendManager);
        }
        for (const g of liteGroups) {
            addAnimationGroup(this._blendManager, g);
            (g as { _ctrl?: unknown })._ctrl = undefined;
        }
    }

    /**
     * Babylon.js `scene.beginAnimation(target, from, to, loop, speedRatio?)`. Runs
     * the animations already attached to `target.animations`.
     */
    public beginAnimation(target: { animations?: Animation[] }, from: number, to: number, loop = false, speedRatio = 1): Animatable {
        return this.beginDirectAnimation(target, target.animations ?? [], from, to, loop, speedRatio);
    }

    public dispose(): void {
        this.onDisposeObservable.notifyObservers(this);
        disposeScene(this._lite);
    }
}
