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
    setClipPlane,
    loadEnvironment,
    loadDdsEnvironment,
    createHemisphericLight,
    addToScene,
    createAnimationManager,
    addAnimationGroup,
    enableAnimationBlending,
    updateAnimationManager,
} from "babylon-lite";
import type { SceneContext, Camera as LiteCamera, ArcRotateCamera as LiteArcRotateCamera, FreeCamera as LiteFreeCamera, AnimationManager } from "babylon-lite";

import { Color3, Color4 } from "../math/color.js";
import type { Plane } from "../math/plane.js";
import { HavokPlugin, PhysicsEngine } from "../physics/physics.js";
import { unsupported } from "../error.js";
import { Observable } from "../misc/observable.js";
import type { Camera } from "../cameras/cameras.js";
import { ArcRotateCamera, FreeCamera } from "../cameras/cameras.js";
import { StandardMaterial } from "../materials/materials.js";
import { Animatable } from "../animations/animation.js";
import type { Animation } from "../animations/animation.js";
import { AnimationGroup } from "../animations/animation.js";
import type { CubeTexture } from "../textures/textures.js";
import type { WebGPUEngine } from "../engine/engine.js";
import { AbstractScene } from "./abstract-scene.js";

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

/**
 * Minimal `SceneContext` stand-in for a headless ({@link NullEngine}) scene, which
 * has no Lite GPU context. It satisfies only the plain data accessors a deviceless
 * scene may touch (`clearColor` / `camera` / `imageProcessing` / `animationGroups`);
 * no Lite scene method is ever invoked on it.
 */
function createHeadlessLite(): SceneContext {
    return {
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        camera: null,
        imageProcessing: { exposure: 1, contrast: 1, toneMappingEnabled: false },
        animationGroups: [],
    } as unknown as SceneContext;
}

export class Scene extends AbstractScene {
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

    /** Babylon.js `scene.getAnimationGroupByName(name)` — first loaded animation group with a matching name, else `null`. */
    public getAnimationGroupByName(name: string): AnimationGroup | null {
        return this.animationGroups.find((g) => g.name === name) ?? null;
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
    private readonly _pendingMorphBuilds: Array<{ mesh: { _lite: unknown }; manager: { _build(mesh: never, engine: import("babylon-lite").EngineContext): void } }> = [];
    private readonly _runningAnimatables: Animatable[] = [];
    private readonly _animationGroupCache = new WeakMap<object, AnimationGroup>();
    /** @internal Structural `AnimationGroup`s stepped + weight-blended each frame. */
    private readonly _structuralGroups: AnimationGroup[] = [];
    /** @internal Lite manager that weight/additive-blends loaded glTF groups (lazily created). */
    private _blendManager: AnimationManager | null = null;
    private _ambientColor = new Color3(0, 0, 0);
    private _environmentIntensity = 1;
    /** @internal Whether this scene is bound to a headless `NullEngine` (no GPU context). */
    private _headless = false;
    /** @internal Tracks whether at least one frame has ticked (gates `onAfterRenderObservable`). */
    private _renderedAFrame = false;
    /** @internal `NodeMaterial`s whose async parse the engine drives after shadow generators are built. */
    private readonly _nodeMaterials: Array<{ _parse(engine: import("babylon-lite").EngineContext, shadowGenerators: readonly unknown[]): Promise<void> }> = [];

    /** @internal Process-unique scene-id source (Babylon.js `scene.uniqueId` / `getUniqueId()`). */
    private static _uidCounter = 0;
    /** Babylon.js `scene.uniqueId` — a process-unique numeric id. */
    public readonly uniqueId = ++Scene._uidCounter;

    public constructor(engine: WebGPUEngine) {
        super();
        this._engine = engine;
        if (engine._headless) {
            // Headless (`NullEngine`): no Lite scene context — the engine drives a
            // pure-JS tick loop (see `NullEngine.runRenderLoop`) that calls `_tick`.
            // Only the deviceless surface (CPU animations, manual canvas drawing)
            // works; there is no GPU rendering. The stub `_lite` satisfies the few
            // plain accessors a headless scene may touch (camera / clearColor / …).
            this._headless = true;
            this._lite = createHeadlessLite();
            engine._registerScene(this);
            return;
        }
        this._lite = createSceneContext(engine._lite);
        // Babylon Lite exposes a before-render hook but no after-render hook. We
        // fire `onBeforeRenderObservable` on each tick, and approximate
        // `onAfterRenderObservable` by firing it at the start of the *next* tick
        // (i.e. after the previous frame has rendered). `addOnce` after-render
        // listeners therefore resolve one frame later than they would in BJS.
        onBeforeRender(this._lite, (deltaMs: number) => this._tick(deltaMs));
        engine._registerScene(this);
    }

    /**
     * @internal Per-frame update: advance CPU animations and fire the render
     * observables. Driven by Babylon Lite's before-render hook for GPU engines, or
     * by the `NullEngine` `requestAnimationFrame` loop for headless engines.
     */
    public _tick(deltaMs: number): void {
        // Record the frame delta so `engine.getDeltaTime()` (read inside before-render
        // observers) reflects the current frame.
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
        if (this._renderedAFrame) {
            this.onAfterRenderObservable.notifyObservers(this);
        }
        this._renderedAFrame = true;
        this.onBeforeRenderObservable.notifyObservers(this);
    }

    public getEngine(): WebGPUEngine {
        return this._engine;
    }

    /** Babylon.js `scene.getClassName()`. */
    public getClassName(): string {
        return "Scene";
    }

    /** Babylon.js `scene.getUniqueId()` — the process-unique scene id. */
    public getUniqueId(): number {
        return this.uniqueId;
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

    /**
     * @internal Register a mesh's compat `MorphTargetManager` to be built at engine
     * start. Building is deferred so the mesh's base CPU geometry (set by primitive
     * builders / `VertexData.applyToMesh`) exists when per-target deltas are computed.
     */
    public _registerMorphTargetManager(mesh: { _lite: unknown }, manager: { _build(mesh: never, engine: import("babylon-lite").EngineContext): void }): void {
        this._pendingMorphBuilds.push({ mesh, manager });
    }

    /** @internal Build all registered morph-target managers. Called by the engine before registration. */
    public _buildMorphTargets(): void {
        const engine = this._engine._lite;
        for (const { mesh, manager } of this._pendingMorphBuilds) {
            manager._build(mesh as never, engine);
        }
        this._pendingMorphBuilds.length = 0;
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
        // Babylon.js accepts a `Color3` here (alpha defaults to 1). A `Color3` has no
        // `a`, which would otherwise reach WebGPU's render pass as `undefined`.
        this._lite.clearColor = { r: value.r, g: value.g, b: value.b, a: value.a ?? 1 };
    }

    public get activeCamera(): Camera | null {
        return this._activeCamera;
    }
    public set activeCamera(camera: Camera | null) {
        this._activeCamera = camera;
        this._lite.camera = (camera?._lite as LiteCamera | undefined) ?? null;
    }

    /**
     * @internal Surface a camera parsed from a loaded asset (`.babylon` files carry
     * their own camera) as the compat `scene.activeCamera`. Babylon Lite's
     * `addToScene` sets `scene._lite.camera` from the asset, but the compat scene
     * only tracks cameras created through the wrapper classes — so after a load with
     * no explicit camera we wrap the Lite one here. Loaded `.babylon` cameras are
     * always free cameras (see `parseBabylonCamera`).
     */
    public _surfaceLoadedCamera(): void {
        if (this._activeCamera || !this._lite.camera) {
            return;
        }
        FreeCamera._adopt("camera", this._lite.camera as LiteFreeCamera, this);
    }

    /** Image-processing exposure proxy (Babylon.js `imageProcessingConfiguration.exposure`). */
    public get imageProcessingConfiguration(): { exposure: number; contrast: number; toneMappingEnabled: boolean } {
        return this._lite.imageProcessing;
    }

    /** Babylon.js `scene.performancePriority` — accepted for parity; Babylon Lite tunes its own pipeline. */
    public performancePriority = 0;

    /**
     * Babylon.js `scene.ambientColor` — the scene-wide ambient term multiplied into
     * each material's ambient contribution. Babylon Lite bakes ambient at the
     * material level (the `.babylon` loader folds `scene.ambientColor` into each
     * material), so this is stored for parity; the BJS default `(0,0,0)` is a no-op.
     */
    public get ambientColor(): Color3 {
        return this._ambientColor;
    }
    public set ambientColor(value: Color3) {
        this._ambientColor = value;
    }

    /**
     * Babylon.js `scene.environmentIntensity` — a global multiplier on IBL
     * contribution. Babylon Lite applies environment intensity per PBR material;
     * this is stored for parity (the BJS default `1` is a no-op).
     */
    public get environmentIntensity(): number {
        return this._environmentIntensity;
    }
    public set environmentIntensity(value: number) {
        this._environmentIntensity = value;
    }

    /**
     * Babylon.js `scene.useRightHandedSystem`. Babylon Lite's coordinate system is
     * fixed; this is stored for parity (the BJS WebGPU default is left-handed —
     * `false` — so the common case is a no-op).
     */
    public useRightHandedSystem = false;

    /** Babylon.js `scene.registerBeforeRender(cb)` — convenience over `onBeforeRenderObservable`. */
    public registerBeforeRender(callback: () => void): void {
        this.onBeforeRenderObservable.add(callback);
    }

    /** Babylon.js `scene.unregisterBeforeRender(cb)`. */
    public unregisterBeforeRender(callback: () => void): void {
        this.onBeforeRenderObservable.removeCallback(callback);
    }

    /** Babylon.js `scene.registerAfterRender(cb)` — convenience over `onAfterRenderObservable`. */
    public registerAfterRender(callback: () => void): void {
        this.onAfterRenderObservable.add(callback);
    }

    /** Babylon.js `scene.unregisterAfterRender(cb)`. */
    public unregisterAfterRender(callback: () => void): void {
        this.onAfterRenderObservable.removeCallback(callback);
    }

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

    // ── Clip plane (Babylon.js `scene.clipPlane`) ──

    private _clipPlane: Plane | null = null;

    /**
     * Babylon.js `scene.clipPlane` — a single world-space clip plane
     * (`normal · p + d = 0`); fragments on the negative side are discarded.
     * Routed to Babylon Lite's opt-in `setClipPlane`.
     */
    public get clipPlane(): Plane | null {
        return this._clipPlane;
    }
    public set clipPlane(value: Plane | null) {
        this._clipPlane = value;
        if (value) {
            setClipPlane(this._lite, [value.normal.x, value.normal.y, value.normal.z, value.d]);
        } else {
            setClipPlane(this._lite, [0, 0, 0, 0]);
        }
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

    /** @internal The active Physics V2 engine, once `enablePhysics` has wired one. */
    private _physicsEngine: PhysicsEngine | null = null;

    /**
     * Babylon.js `scene.enablePhysics(gravity, plugin)`. Wires the given Havok V2
     * {@link HavokPlugin} to this scene, creating the native Lite physics world and
     * registering per-frame stepping. The plugin's `useDeltaForWorldStep` flag
     * controls whether the world advances by elapsed frame time (refresh-rate
     * independent — issue #332) or a fixed `1/60` step.
     *
     * Bodies are created with the native `createPhysicsAggregate` /
     * `createPhysicsBody` API against `scene.getPhysicsEngine().getPhysicsPlugin().world`.
     * @returns `true` once physics is enabled.
     */
    public enablePhysics(gravity?: { x: number; y: number; z: number } | null, plugin?: HavokPlugin): boolean {
        if (this._headless) {
            return unsupported("Scene.enablePhysics", "A headless (NullEngine) scene has no render loop to step physics.");
        }
        if (!(plugin instanceof HavokPlugin)) {
            return unsupported("Scene.enablePhysics", "Pass a `HavokPlugin` instance (Babylon Lite physics is Havok-V2 only).");
        }
        const g = gravity ?? { x: 0, y: -9.81, z: 0 };
        plugin._attachToLiteScene(this._lite, g);
        this._physicsEngine = new PhysicsEngine(plugin, g);
        return true;
    }

    /** Babylon.js `scene.getPhysicsEngine()` — the active Physics V2 engine, or `null`. */
    public getPhysicsEngine(): PhysicsEngine | null {
        return this._physicsEngine;
    }

    /** Babylon.js `scene.isPhysicsEnabled()`. */
    public isPhysicsEnabled(): boolean {
        return this._physicsEngine !== null;
    }

    /** Babylon.js `scene.disablePhysicsEngine()` — release the active physics world. */
    public disablePhysicsEngine(): void {
        if (this._physicsEngine) {
            this._physicsEngine.dispose();
            this._physicsEngine = null;
        }
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
        // A headless scene has no Lite context to dispose (see `createHeadlessLite`).
        if (!this._headless) {
            disposeScene(this._lite);
        }
    }
}
