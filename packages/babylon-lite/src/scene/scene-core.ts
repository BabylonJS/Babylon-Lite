import type { EngineContext, RenderingContext } from "../engine/engine.js";
import { _vis, isRenderingContextRegistered, registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { SurfaceContext } from "../engine/surface.js";
import type { Camera } from "../camera/camera.js";
import type { LightBase } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { registerMeshScene, unregisterMeshScene, enqueueMaterialSwap } from "./mesh-scene-registry.js";
import { processMaterialSwaps } from "./scene-material-swap.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import { tickAnimation } from "../animation/animation-tick.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";
import type { FogConfig } from "../material/standard/standard-material.js";
import type { Renderable, PrePassRenderable, SceneUniformUpdater, MeshGroupBuilder } from "../render/renderable.js";
import type { TransformNode } from "./transform-node.js";
import type { SceneNode } from "./scene-node.js";
import type { EnvironmentTextures } from "../loader-env/load-env.js";
import type { EnvironmentRecoverySource } from "../loader-env/environment-recovery.js";
import type { FrameGraph } from "../frame-graph/frame-graph.js";
import { createFrameGraph, _appendTask } from "../frame-graph/frame-graph.js";
import { createRenderTask } from "../frame-graph/render-task.js";
import { createRenderTarget } from "../engine/render-target.js";
import type { AssetContainer } from "../asset-container.js";
import type { SceneLightGpuState } from "../render/lights-ubo.js";
import type { ClusteredLightContainer } from "../light/clustered.js";
import type { FgRuntime } from "../flow-graph/runtime.js";
import type { PickSource } from "../picking/pick-contributor.js";
import type { ToneMapping } from "../material/pbr/tone-mapping.js";
import type { FgEventBus } from "../flow-graph/event-bus.js";

/** Image processing configuration. */
export interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
    /**
     * Tone mapping algorithm applied by PBR materials when `toneMappingEnabled` is true.
     * Undefined means the default {@link StandardToneMapping} (exponential). Assign a
     * built-in ({@link StandardToneMapping}, {@link AcesToneMapping}, {@link NeutralToneMapping})
     * or a custom {@link ToneMapping}.
     *
     * This is baked into the PBR shaders at `registerScene()` time. To change it after
     * registration, use `setSceneImageProcessing` so the affected pipelines are rebuilt.
     */
    toneMapping?: ToneMapping;
}

/** A clipping plane expressed as the coefficients `[a, b, c, d]` of `a·x + b·y + c·z + d`. */
export type ClipPlane = readonly [number, number, number, number];

/** @internal Visible-environment skybox source type. */
export type EnvironmentSkyboxKind = "dds" | "hdr";

/** @internal One feature-owned transformation of a visible-environment skybox shader. */
export interface EnvironmentSkyboxShaderPatch {
    /** @internal */
    _apply(fragment: string, kind: EnvironmentSkyboxKind): string;
}

/** @internal Lazy access to one feature-owned visible-environment shader patch. */
export type EnvironmentSkyboxShaderPatchLoader = () => EnvironmentSkyboxShaderPatch | Promise<EnvironmentSkyboxShaderPatch>;

/** @internal Scene-local composition hook installed only by environment feature setters. */
export type EnvironmentSkyboxShaderComposer = (fragment: string, kind: EnvironmentSkyboxKind) => Promise<string>;

/** @internal Runtime mesh-build hooks installed only after a material group must widen its capabilities. */
export interface RuntimeSceneBuildHooks {
    queue(builder: MeshGroupBuilder, mesh: Mesh): Promise<void>;
    all(): Promise<void>;
    track(promise: Promise<void>): Promise<void>;
    base(builder: MeshGroupBuilder, rebuild: NonNullable<MeshGroupBuilder["_rebuildSingle"]>): NonNullable<MeshGroupBuilder["_rebuildSingle"]>;
    readonly w: boolean;
    reset(mesh: Mesh): void;
    remove(mesh: Mesh): void;
    /** Forget every rebuild closure cached for this builder in this scene. Called when a group's output is
     *  dropped: the cached closures baked the light/shadow topology of the build being discarded, so
     *  re-dispatching through them would bind resources the rebuild is about to retire. */
    dropBase(builder: MeshGroupBuilder): void;
    wait(meshes: readonly Mesh[]): Promise<void>;
    /** @internal */
    _e(clear?: boolean): void;
    /** @internal */
    _x(error: unknown): void;
    /** @internal */
    _d(): boolean;
    exclusive<T>(builder: MeshGroupBuilder, work: () => Promise<T>): Promise<T>;
}

/** @internal Scene-owned mesh group plus the rebuild closure captured by its completed build. */
export interface SceneMeshGroup extends Array<Mesh> {
    r?: NonNullable<MeshGroupBuilder["_rebuildSingle"]>;
    /** Renderables this group's last build produced. `_renderables` also holds feature-owned entries
     *  (skybox, ground, HDR, Gaussian splats), and a group's meshes can be MERGED into a single renderable
     *  whose `mesh` is undefined — so a rebuild cannot recover ownership by mesh identity and would leave
     *  the stale merged renderable drawing alongside its replacement. Kept on the group (next to `r`) so
     *  every path that replaces a group's output updates it in the same place. */
    o?: Renderable[];
    /** @internal Optional widening predicate for material capabilities not captured by `r`. */
    _w?: ((mesh: Mesh) => unknown) | null;
}

let _lateCleanup: WeakMap<SceneContext, () => 1> | null = null;

/** Top-level scene context — pure state, no attached methods. */
export interface SceneContext extends RenderingContext {
    /** @internal */
    readonly _kind: "scene";
    /** Surface this scene renders into. Set at scene-creation time and immutable
     *  afterwards — the default render task is sized and MSAA-matched to this surface,
     *  and `registerScene` attaches the scene to it. For the engine's primary surface
     *  (the common single-canvas case) this is the engine itself. The owning engine is
     *  reachable via `scene.surface.engine`. */
    readonly surface: SurfaceContext;
    clearColor: GPUColorDict;
    camera: Camera | null;
    lights: LightBase[];
    imageProcessing: ImageProcessingConfig;

    /** All meshes added to the scene (standard + PBR). */
    meshes: Mesh[];

    /** Animation groups loaded from glTF or created manually. */
    animationGroups: AnimationGroup[];

    /** Fog configuration. Null = no fog. */
    fog: FogConfig | null;

    /** Scene clip plane as (normal.x, normal.y, normal.z, d). Matches Babylon.js Plane `dot(worldPosition, plane) > 0` discard semantics. */
    clipPlane: ClipPlane | null;

    /** Shadow generators registered on this scene. */
    shadowGenerators: ShadowGenerator[];

    /** Background material primaryColor (linear RGB). Default from Babylon createDefaultEnvironment. */
    environmentPrimaryColor?: [number, number, number];

    /** @internal Environment cubemap Y rotation in radians. Set through `setEnvironmentRotation`. */
    _environmentRotation?: number;

    /** @internal Optional visible-environment blur amount. */
    _environmentBlur?: number;

    /** @internal Feature-owned visible-environment shader patch loaders, indexed by composition order. */
    _environmentSkyboxShaderPatchLoaders?: EnvironmentSkyboxShaderPatchLoader[];

    /** @internal Scene-local visible-environment shader composer installed by feature setters. */
    _environmentSkyboxShaderComposer?: EnvironmentSkyboxShaderComposer;

    /** Fixed delta time in ms for deterministic animation. 0 = use real rAF delta. */
    fixedDeltaMs: number;

    /** All renderables in this scene. The active frame-graph tasks bucket them
     *  (opaque / direct / transparent) at bind time based on `isTransparent`, `_direct`, and `_transmissive`. */
    /** @internal */
    _renderables: Renderable[];
    /** @internal Pre-pass work (shadow maps, compute, etc.). */
    _prePasses: PrePassRenderable[];
    /** Pick sources — one per optional pickable entity (GS mesh, billboard system, …). Registered by
     *  the entity module via `registerPickSource` when the entity is added; each is pure data + a
     *  dynamic-import thunk the GPU picker resolves (once) on the first pick, so rendering the entity
     *  pulls no pick-pipeline bytes. Scene-core stays pick-agnostic apart from this opaque list. */
    /** @internal */
    _pickSources: PickSource[];
    /** @internal Scene uniform updaters (one per shared UBO). */
    _uniformUpdaters: SceneUniformUpdater[];
    /** @internal Opt-in feature writers for the SceneUniforms UBO (fog, clip plane, environment).
     *  Populated lazily via the scene-ubo-extras seam; run by the render task. */
    _sceneUboContributors?: ((data: Float32Array, scene: SceneContext) => void)[];
    /** @internal Per-frame callbacks run before rendering (animation, physics, etc.). */
    _beforeRender: ((deltaMs: number) => void)[];
    /** @internal Deferred builders — registered by loaders/factories, run once at startEngine(). */
    _deferredBuilders: (() => void | Promise<void>)[];
    /** @internal Mesh group registry — maps builder to its mesh list (internal bookkeeping). */
    _groups: Map<MeshGroupBuilder, SceneMeshGroup>;
    /** @internal Monotonic counter bumped when a light is REMOVED from the scene (see `removeFromScene`).
     *  The lights-UBO refresh compares it separately from the per-light version sum: without it, swapping
     *  one light for another (same count, and the sums can match) leaves the UBO holding the removed
     *  light's data. Adds alone are covered by the count change. */
    _lightListVersion?: number;
    /** @internal Rebuild entry point installed by `removeFromScene` when light/shadow topology changed after
     *  the initial build. Renderables bake the light index list, the light-count shader permutation and the
     *  shadow bind group at build time, so the scene must be rebuilt for the change to take effect. Called
     *  by `buildScene`, i.e. on the next registration — scenes that never mutate topology never install it,
     *  and the rebuild code stays out of their bundle. */
    _rebuildHook?: (scene: SceneContext) => Promise<void>;
    /** @internal GPU teardown deferred until a rebuild has replaced the bind groups that still reference the
     *  removed resources (make-before-break). Drained by the topology rebuild and by `disposeScene`. */
    _pendingTopologyRetirements?: (() => void)[];
    /** @internal Lazy runtime-build hooks; absent in scenes that never widen a material group post-build. */
    _runtimeBuilds?: RuntimeSceneBuildHooks;
    /** @internal True after scene disposal; used to abort asynchronous recovery/rebuild work. */
    _z?: boolean;
    /** @internal Temporary PBR transmission transaction sink used while rebuilding scene material groups. */
    _p?: (value: readonly [commit: () => void, rollback: () => void]) => boolean;

    // ─── Dispose infrastructure ────────────────────────────────
    /** @internal Shared cleanup callbacks (scene UBOs, lights UBOs, etc.). Registered by builders. */
    _disposables: (() => void)[];
    /** @internal Per-mesh cleanup callbacks (mesh UBOs, bind groups). For material swap + dispose. */
    _meshDisposables: Map<Mesh, (() => void)[]>;
    /** @internal Per-mesh cleanup callbacks for AUX (material-OVERRIDE) view packets that an explicit render
     *  task registered on a mesh it does not own — e.g. a depth-prepass / SSAO no-colour view of a wall. Kept
     *  SEPARATE from `_meshDisposables` because a MAIN-material swap (`processMaterialSwaps`, which rebuilds
     *  only the main renderable) must NOT tear these down: they belong to another task, whose cached bundle
     *  would then replay a destroyed system UBO ("used in submit while destroyed"). Drained only on a real mesh
     *  removal (`removeFromScene`) and scene dispose, exactly like `_meshDisposables` minus the swap path. */
    _meshAuxDisposables: Map<Mesh, (() => void)[]>;
    /** @internal Meshes whose material was changed via setter — drained before each render frame. */
    _materialSwapQueue: Mesh[];
    /** @internal Monotonic counter bumped when the renderable list changes (add/remove/rebuild). */
    _renderableVersion: number;
    /** @internal Monotonic counter bumped ONLY when a material's renderables are rebuilt/swapped (material
     *  swap drain or `rebuildMaterial`) — NOT on a geometry resize (which bumps `_renderableVersion` alone).
     *  Lets consumers that cache material-view-derived GPU state (e.g. the CSM shadow tasks' no-color material
     *  views) cheaply re-record on a geometry-only edit and only fully rebuild when a caster's material UBOs
     *  were actually destroyed/recreated (which would otherwise leave their cached views dangling). */
    _materialEpoch: number;
    /** True once the initial deferred build (buildScene) has run. Meshes added after
     *  this point use either the per-frame rebuild drain or an isolated async build
     *  when they widen the group's captured capabilities. */
    /** @internal */
    _built: boolean;
    // ─── Stashed internal state (typed to avoid `as any` casts) ────
    /** @internal */
    _envTextures?: EnvironmentTextures;
    /** @internal Loader metadata retained only while Scene recovery capture is enabled. */
    _envRecoverySource?: EnvironmentRecoverySource;
    /** @internal Scene-owned shared LightsUniforms UBO state (group 0 binding 1). */
    _lightGpuState?: SceneLightGpuState;

    /** Frame graph driving this scene's rendering. Created eagerly by
     *  `createSceneContext` with a default `RenderTask` that mirrors
     *  `_renderables` into the swapchain. User code may add additional tasks
     *  (offscreen RTTs, post-FX, UI overlays, etc.). */
    /** @internal */
    _frameGraph: FrameGraph;

    /** @internal Optional clustered point/spot-light container. Only populated by the clustered-light extension API. */
    _clusteredLightContainer?: ClusteredLightContainer;
    /** @internal Updates clustered light cells for the camera used by the current render pass. */
    _clusteredLightUpdater?: (camera: Camera | null | undefined, targetWidth: number, targetHeight: number) => void;

    /** @internal Flow-graph runtimes attached to this scene (visual scripting /
     *  glTF KHR_interactivity). Lazily created by `attachFlowGraph`; left
     *  undefined for non-interactivity scenes so core stays byte-identical.
     *  Driven via the generic `onBeforeRender` seam, not a hardcoded core loop. */
    _flowGraphs?: FgRuntime[];

    /** @internal Scene-scoped flow-graph event bus shared by all graphs attached
     *  to this scene, so multiple graphs exchange custom events. Lazily created
     *  by `flowGraphBus`; undefined for non-interactivity scenes. */
    _flowGraphBus?: FgEventBus;
    /** @internal Scene-wide Flow Graph frame callback, registered lazily. */
    _flowGraphTick?: (deltaMs: number) => void;
    /** @internal Scene-wide Flow Graph disposal callback, registered lazily. */
    _flowGraphDispose?: () => void;
    /** @internal In-flight lazy setup for the Flow Graph pointer-selection bridge. */
    _flowGraphPointerInit?: Promise<void>;
    /** @internal Removes the Flow Graph pointer listener and disposes its picker. */
    _flowGraphPointerCleanup?: () => void;
}

/** Options passed to the scene-context factory. */
export interface SceneContextOptions {
    defaultRenderTask?: boolean;
}

/** Create an empty scene context bound to the given `surface`. The default render task
 *  is built against the surface's format, MSAA configuration, and swapchain RT — the
 *  scene is permanently bound to that surface. Pass `engine` directly (since
 *  `EngineContext extends SurfaceContext`) for the common single-canvas case, or pass
 *  an auxiliary surface created via `createSurface`. */
export function createSceneContext(surface: SurfaceContext, options?: SceneContextOptions): SceneContext {
    const eng = surface.engine;

    // Closures below capture `ctx` by-reference via this object.
    const ctxLocal: Omit<SceneContext, "_frameGraph"> = {
        _kind: "scene",
        surface,
        clearColor: { r: 0.2, g: 0.2, b: 0.3, a: 1.0 },
        camera: null,
        lights: [],
        meshes: [],
        animationGroups: [],
        fog: null,
        clipPlane: null,
        shadowGenerators: [],
        imageProcessing: { exposure: 1.0, contrast: 1.0, toneMappingEnabled: false },
        _renderables: [],
        _prePasses: [],
        _pickSources: [],
        _uniformUpdaters: [],
        fixedDeltaMs: 0,
        _beforeRender: [],
        _deferredBuilders: [],
        _groups: new Map(),
        _disposables: [],
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
        _materialSwapQueue: [],
        _renderableVersion: 0,
        _materialEpoch: 0,
        _built: false,
        _drawCallsPre: 0,

        _update(): void {
            // When the engine was created with `useFloatingOrigin: true`, mark
            // the active camera so `getViewMatrix` knows to zero its
            // translation column (the GPU view × world product is then the
            // eye-relative result the LWR offset trick produces). For non-LWR
            // engines `eng.useFloatingOrigin` is false and this is a single
            // boolean check per frame — the inner branch is dead.
            if (eng.useFloatingOrigin && ctx.camera && !ctx.camera._useFloatingOrigin) {
                ctx.camera._useFloatingOrigin = true;
                ctx.camera._viewVer = -1;
                ctx.camera._vpVer = -1;
            }
            const d = ctx.fixedDeltaMs > 0 ? ctx.fixedDeltaMs : eng._currentDelta;
            const encoder = eng._currentEncoder;
            let draws = 0;
            for (const cb of ctx._beforeRender) {
                cb(d);
            }
            if (ctx._materialSwapQueue.length) {
                void processMaterialSwaps(ctx);
            }
            for (const pp of ctx._prePasses) {
                draws += pp.execute(encoder, eng);
            }
            for (const u of ctx._uniformUpdaters) {
                u.update(eng);
            }
            ctx._drawCallsPre = draws;
        },
        _record(): number {
            return ctx._frameGraph.execute();
        },
        _resize(): void {
            // Canvas backing-store changed: rebuild the frame graph so canvas-sized
            // render targets get re-allocated at the new pixel size before the next record.
            ctx._frameGraph.build();
        },
    };

    const ctx = ctxLocal as SceneContext;
    // Eagerly attach the frame graph + a default swapchain render-pass task. The
    // graph drives all GPU work for this scene; user code can add more tasks
    // (offscreen RTTs, post-FX, UI overlays) before/after.
    const fg = createFrameGraph(eng);
    ctx._frameGraph = fg;
    if (options?.defaultRenderTask !== false) {
        // MSAA: render into an MSAA colour RT (which owns depth) and resolve into the
        // single-sample scRT. No MSAA: render straight into the colour-only
        // scRT with a task-owned single-sample depth buffer it builds/clears/frees.
        // All three reads (format / msaaSamples / scRT) come from the bound `surface`.
        const msaa = surface.msaaSamples > 1;
        const rt = msaa
            ? createRenderTarget({ lbl: "scene-color", format: surface.format, dFormat: "depth24plus-stencil8", samples: surface.msaaSamples, size: surface })
            : surface.scRT;
        const depth = msaa ? undefined : createRenderTarget({ lbl: "scene-depth", dFormat: "depth24plus-stencil8", samples: 1, size: surface });
        _appendTask(fg, createRenderTask({ name: "scene", rt, rst: msaa ? surface.scRT : undefined, depth }, eng, ctx));
    }
    ctx._disposables.push(() => fg.dispose());
    return ctx;
}

/** Register a callback to run before each rendered frame. */
export function onBeforeRender(scene: SceneContext, cb: (deltaMs: number) => void): void {
    (scene as SceneContext)._beforeRender.unshift(cb);
}

/** Register a callback to run when `disposeScene` is called. Used to tie
 *  user-owned GPU resources (e.g. a `SpriteRenderer`) to the scene's lifetime. */
export function onSceneDispose(scene: SceneContext, cb: () => void): void {
    (scene as SceneContext)._disposables.push(cb);
}

/** Get the scene's frame graph. Always non-null — created in `createSceneContext`. */
export function getFrameGraph(scene: SceneContext): FrameGraph {
    return (scene as SceneContext)._frameGraph;
}

export interface DeferredSceneRenderables {
    renderables: readonly Renderable[];
    dispose?: () => void;
}

/** @internal Register optional scene-hosted render work without teaching `addToScene` about the feature. */
export function addDeferredSceneRenderables(
    scene: SceneContext,
    build: (engine: EngineContext, scene: SceneContext) => DeferredSceneRenderables | Promise<DeferredSceneRenderables>
): void {
    const ctx = scene as SceneContext;
    ctx._deferredBuilders.push(async () => {
        const built = await build(ctx.surface.engine, ctx);
        ctx._renderables.push(...built.renderables);
        if (built.dispose) {
            ctx._disposables.push(built.dispose);
        }
    });
}

/**
 * Adds an entity (mesh, light, camera, transform node, shadow generator, or asset container)
 * to the scene, dispatching on its type. Asset containers are unpacked and each contained
 * entity added recursively. Optional scene-hosted systems such as depth-hosted sprites
 * expose their own opt-in add functions so mesh-only scenes do not pay feature-specific
 * routing bytes here.
 * @param scene - The owning scene (pillar 4b: entities never reference the scene themselves).
 * @param entity - The entity (or asset container) to add.
 * @throws When `entity` is a mesh that was already disposed — `removeFromScene` (or
 * `disposeScene`) releases a mesh's claim on its GPU resources when it leaves its LAST scene, and
 * calling the public `disposeMeshGpu(mesh)` yourself does the same. A disposed mesh is retired for
 * good; create a new mesh instead of re-adding it. The mesh itself is rejected before any scene
 * state is touched; when adding a hierarchy or asset container, entities processed before the
 * offending mesh stay added.
 */
export function addToScene(scene: SceneContext, entity: Mesh | LightBase | Camera | ShadowGenerator | TransformNode | AssetContainer): void {
    const ctx = scene as SceneContext;
    // AssetContainer from loadGltf / loadBabylon — process each field present
    if ("entities" in entity) {
        const result = entity as AssetContainer;
        for (const e of result.entities) {
            addToScene(scene, e);
        }
        if (result.clearColor) {
            ctx.clearColor = result.clearColor;
        }
        if (result.camera && !ctx.camera) {
            ctx.camera = result.camera;
        }
        if (result.animationGroups?.length) {
            const engine = ctx.surface.engine;
            const groups = result.animationGroups;
            ctx.animationGroups.push(...groups);
            const hook = (deltaMs: number): void => {
                for (const g of groups) {
                    tickAnimation(g, deltaMs, engine);
                }
            };
            result._beforeRenderHook = hook;
            ctx._beforeRender.push(hook);
        }
        // Feature-owned scene wiring runs synchronously before registerScene() builds
        // renderables. Lazy features also own any cleanup registration they require.
        result._sceneSetup?.(ctx, result);
        return;
    }
    if ("_gpu" in entity && "material" in entity) {
        const mesh = entity as unknown as Mesh;
        // Register BEFORE mutating scene state: registering a disposed mesh throws, and the
        // scene must be left untouched when it does.
        registerMeshScene(ctx, mesh);
        ctx.meshes.push(mesh);
        const build = mesh.material ? (mesh.material as unknown as { _buildGroup?: MeshGroupBuilder })._buildGroup : undefined;
        if (build) {
            let group = ctx._groups.get(build);
            if (!group) {
                group = [] as SceneMeshGroup;
                ctx._groups.set(build, group);
                if (!ctx._built) {
                    ctx._deferredBuilders.push(async () => {
                        const result = await build(ctx, group!);
                        ctx._renderables.push(...result.renderables);
                        group!.o = result.renderables;
                        if (result.updater) {
                            ctx._uniformUpdaters.push(result.updater);
                        }
                        group!.r = result.rebuildSingle;
                    });
                }
            }
            group.push(mesh);
            // Materialize this mesh's renderable through the per-frame material-swap drain when the boot-only
            // deferred builder won't cover it: either after the initial build (`_built`), or when joining a group
            // whose builder has ALREADY completed (`group.r`) — e.g. a glTF prop whose async load resolves
            // mid-drain and joins an already-built group. A mesh joining a group whose builder has NOT yet run (a
            // brand-new group, or one still pending in the drain) is built by that builder, so it must NOT enqueue
            // here — that would insert a SECOND renderable for it. buildScene drains the queue at the end.
            if (ctx._built || group.r) {
                enqueueMaterialSwap(ctx, mesh);
            }
        }
    } else if ("lightType" in entity) {
        ctx.lights.push(entity as LightBase);
    }
    // Recurse into children of meshes, lights, cameras — set parent links
    const kids = (entity as unknown as SceneNode).children;
    if (kids?.length) {
        for (const child of kids) {
            (child as unknown as SceneNode).parent = entity as unknown as SceneNode;
            addToScene(scene, child);
        }
    }
}

/** Release all GPU resources owned by this scene. */
export function disposeScene(scene: SceneContext): void {
    const ctx = scene as SceneContext;
    if (ctx._z) {
        return;
    }
    ctx._z = true;
    const lateCleanup = (_lateCleanup ??= new WeakMap());
    lateCleanup.set(ctx, () => 1);
    unregisterRenderingContext(ctx.surface, ctx);
    const cleanup = (): void => {
        lateCleanup.set(ctx, () => {
            for (const fns of ctx._meshDisposables.values()) {
                fns.forEach((dispose) => dispose());
            }
            for (const fns of ctx._meshAuxDisposables.values()) {
                fns.forEach((dispose) => dispose());
            }
            ctx._meshDisposables.clear();
            ctx._meshAuxDisposables.clear();
            ctx._disposables.splice(0).forEach((dispose) => dispose());
            ctx._renderables.length = ctx._uniformUpdaters.length = 0;
            return 1;
        });
        for (const fn of ctx._disposables) {
            fn();
        }
        for (const fns of ctx._meshDisposables.values()) {
            for (const fn of fns) {
                fn();
            }
        }
        ctx._meshDisposables.clear();
        for (const fns of ctx._meshAuxDisposables.values()) {
            for (const fn of fns) {
                fn();
            }
        }
        ctx._meshAuxDisposables.clear();
        for (const mesh of ctx.meshes) {
            // Free the mesh's shared GPU buffers only when this was its LAST owning scene.
            // `disposeMeshGpu` is idempotent (`mesh._disposed`), so a deferred free still in flight
            // for this mesh — removed, then the scene disposed before the retirement drained —
            // cannot release the same shared resource a second time.
            if (unregisterMeshScene(ctx, mesh)) {
                disposeMeshGpu(mesh);
            }
        }
        ctx._groups.clear();
        ctx.meshes.length = 0;
        ctx._renderables.length = 0;
        ctx._prePasses.length = 0;
        ctx._pickSources.length = 0;
        ctx._uniformUpdaters.length = 0;
        ctx._beforeRender.length = 0;
        ctx._deferredBuilders.length = 0;
        ctx._disposables.length = 0;
        ctx._materialSwapQueue.length = 0;
        ctx.lights.length = 0;
        ctx.animationGroups.length = 0;
        ctx.shadowGenerators.length = 0;
        ctx.camera = null;
    };
    cleanup();
}

/** @internal Run all deferred builders (called by registerScene's boot step before the first frame). */
export async function buildScene(scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContext;
    // Discard material-swap requests enqueued during INITIAL scene setup — a mesh added, then re-materialed before
    // boot via the mesh.material setter (e.g. scene12 assigns each row's material AFTER addToScene). The deferred
    // builders below build every group's meshes fresh with their FINAL material, so those swaps are redundant;
    // processing them would insert a SECOND renderable per mesh (double-draw). On re-registration the queued swaps
    // are real runtime changes and must survive so a newly introduced material group can be built below.
    if (!ctx._built) {
        ctx._materialSwapQueue.length = 0;
    }
    while (ctx._deferredBuilders.length) {
        const builders = ctx._deferredBuilders.splice(0);
        // Promise.all treats synchronous void results as already resolved.
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await Promise.all(builders.map((b) => b()));
    }
    // Build the renderables for any meshes that joined an already-built group mid-drain (queued above) before
    // the first frame, instead of leaving them casting shadows but invisible in the color pass.
    await processMaterialSwaps(ctx);
    _lateCleanup?.get(ctx)?.() || (ctx._runtimeBuilds?._e(), ctx._renderableVersion++, (ctx._built = true));
    // Light/shadow topology changed since the last build (hook installed by `removeFromScene`): re-run the
    // group builders so the baked light indices, light-count permutation and shadow bind groups match.
    await ctx._rebuildHook?.(ctx);
}

let _prepareShaderPipelines: ((scene: SceneContext) => Promise<void>) | null = null;
/** @internal Install the optional async ShaderMaterial preparation boundary. */
export function _installAsyncShaderPipelinePreparation(prepare: (scene: SceneContext) => Promise<void>): void {
    _prepareShaderPipelines = prepare;
}

/**
 * Register a scene with the engine. Builds deferred work, sorts renderables by order,
 * and adds the scene to its bound surface's render list in overlay order. The scene is
 * always attached to `scene.surface` (which equals the engine itself in the
 * single-canvas case).
 */
export async function registerScene(scene: SceneContext): Promise<void> {
    const ctx = scene;
    const surface = ctx.surface;
    if (isRenderingContextRegistered(surface, ctx)) {
        return;
    }
    await buildScene(scene);
    ctx._renderables.sort(byOrder);
    // Promise.all treats tasks without a preload hook as already resolved.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await Promise.all(ctx._frameGraph._tasks.map((task) => task._preload?.()));
    if (_prepareShaderPipelines) {
        await _prepareShaderPipelines(ctx);
    }
    ctx._frameGraph.build();
    if (surface._renderingContexts[0]) {
        const overlay = await import("./swapchain-overlay.js");
        overlay.configureSwapchainOverlayScene(surface, ctx);
    }
    _lateCleanup?.get(ctx)?.() || registerRenderingContext(surface, ctx);
}

/**
 * Register a scene with the engine and install the scene-owned shadow frame-graph task.
 * Use only for scenes that generate shadow maps. Like {@link registerScene}, the scene
 * is attached to `scene.surface` (and its owning engine is `scene.surface.engine`).
 */
export async function registerSceneWithShadowSupport(scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContext;
    const surface = ctx.surface;
    if (isRenderingContextRegistered(surface, ctx)) {
        return;
    }
    await buildScene(scene);
    ctx._renderables.sort(byOrder);
    await ensureShadowTask(surface.engine, ctx);
    // Promise.all treats tasks without a preload hook as already resolved.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await Promise.all(ctx._frameGraph._tasks.map((task) => task._preload?.()));
    if (_prepareShaderPipelines) {
        await _prepareShaderPipelines(ctx);
    }
    ctx._frameGraph.build();
    if (surface._renderingContexts[0]) {
        const overlay = await import("./swapchain-overlay.js");
        overlay.configureSwapchainOverlayScene(surface, ctx);
    }
    _lateCleanup?.get(ctx)?.() || registerRenderingContext(surface, ctx);
}

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;

async function ensureShadowTask(engine: EngineContext, scene: SceneContext): Promise<void> {
    // Idempotent: the scene keeps its `_frameGraph` (and its `_tasks`) across unregister/re-register
    // cycles, and `buildScene` does not clear the task list — so a plain unshift would stack a new
    // shadow task on every re-registration. Only add one when the scene has none.
    if (scene._frameGraph._tasks.some((task) => task.name === "shadow")) {
        return;
    }
    const { createShadowTask } = await import("../frame-graph/shadow-task.js");
    scene._frameGraph._tasks.unshift(createShadowTask(engine, scene));
}

/** Remove a previously-registered scene. Idempotent. Does not dispose scene resources.
 *  The scene is always removed from `scene.surface`. */
export function unregisterScene(scene: SceneContext): void {
    unregisterRenderingContext(scene.surface, scene as SceneContext);
}
