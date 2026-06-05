import type { EngineContext, RenderingContext } from "../engine/engine.js";
import { _vis, isRenderingContextRegistered, registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { Camera } from "../camera/camera.js";
import type { LightBase } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";
import type { FogConfig } from "../material/standard/standard-material.js";
import type { Renderable, PrePassRenderable, SceneUniformUpdater, MeshGroupBuilder } from "../render/renderable.js";
import type { TransformNode } from "./transform-node.js";
import type { SceneNode } from "./scene-node.js";
import type { EnvironmentTextures } from "../loader-env/load-env.js";
import type { FrameGraph } from "../frame-graph/frame-graph.js";
import { createFrameGraph, _appendTask } from "../frame-graph/frame-graph.js";
import { createRenderTask } from "../frame-graph/render-task.js";
import { createRenderTarget } from "../engine/render-target.js";
import type { AssetContainer } from "../asset-container.js";
import type { SceneLightGpuState } from "../render/lights-ubo.js";
import type { ClusteredLightContainer } from "../light/clustered.js";
import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";

/** Image processing configuration. */
export interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
    /** "standard" (BJS TONEMAPPING_STANDARD, default) or "aces" (BJS TONEMAPPING_ACES). */
    toneMappingType?: "standard" | "aces";
}

/** A clipping plane expressed as the coefficients `[a, b, c, d]` of `a·x + b·y + c·z + d`. */
export type ClipPlane = readonly [number, number, number, number];

/** Top-level scene context — pure state, no attached methods. */
export interface SceneContext extends RenderingContext {
    readonly engine: EngineContext;
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

    /** Environment cubemap Y rotation in radians. */
    envRotationY?: number;

    /** Fixed delta time in ms for deterministic animation. 0 = use real rAF delta. */
    fixedDeltaMs: number;

    /** All renderables in this scene. The active frame-graph tasks bucket them
     *  (opaque / direct / transparent) at bind time based on `isTransparent`, `_direct`, and `_transmissive`. */
    /** @internal */
    _renderables: Renderable[];
    /** @internal Pre-pass work (shadow maps, compute, etc.). */
    _prePasses: PrePassRenderable[];
    /** GaussianSplatting meshes attached to this scene.  Populated by
     *  `attachGaussianSplattingMesh`.  Scene-core stays GS-agnostic apart from
     *  this opaque registry (used by `gpu-picker` to iterate GS meshes without
     *  scanning `_renderables`). */
    /** @internal */
    _gsMeshes: GaussianSplattingMesh[];
    /** @internal Scene uniform updaters (one per shared UBO). */
    _uniformUpdaters: SceneUniformUpdater[];
    /** @internal Opt-in feature writers for the SceneUniforms UBO (fog, clip plane, env SH).
     *  Populated lazily via the scene-ubo-extras seam; run by the render task. */
    _sceneUboContributors?: ((data: Float32Array, scene: SceneContext) => void)[];
    /** @internal Per-frame callbacks run before rendering (animation, physics, etc.). */
    _beforeRender: ((deltaMs: number) => void)[];
    /** @internal Deferred builders — registered by loaders/factories, run once at startEngine(). */
    _deferredBuilders: (() => void | Promise<void>)[];
    /** @internal Mesh group registry — maps builder to its mesh list (internal bookkeeping). */
    _groups: Map<MeshGroupBuilder, Mesh[]>;

    // ─── Dispose infrastructure ────────────────────────────────
    /** @internal Shared cleanup callbacks (scene UBOs, lights UBOs, etc.). Registered by builders. */
    _disposables: (() => void)[];
    /** @internal Per-mesh cleanup callbacks (mesh UBOs, bind groups). For material swap + dispose. */
    _meshDisposables: Map<Mesh, (() => void)[]>;
    /** @internal Meshes whose material was changed via setter — drained before each render frame. */
    _materialSwapQueue: Mesh[];
    /** @internal Monotonic counter bumped when the renderable list changes (add/remove/rebuild). */
    _renderableVersion: number;
    /** @internal Lazily-loaded processor; populated on first material reassignment. */
    _processSwaps?: (scene: SceneContext) => void;
    /** True once the initial deferred build (buildScene) has run. Meshes added after
     *  this point are materialized via the per-frame swap drain rather than the
     *  boot-only deferred-builder path. */
    /** @internal */
    _built: boolean;

    // ─── Stashed internal state (typed to avoid `as any` casts) ────
    /** @internal */
    _envTextures?: EnvironmentTextures;
    /** @internal Scene-owned shared LightsUniforms UBO state (group 0 binding 1). */
    _lightGpuState?: SceneLightGpuState;

    /** Frame graph driving this scene's rendering. Created eagerly by
     *  `createSceneContext` with a default `RenderTask` that mirrors
     *  `_renderables` into the swapchain. User code may add additional tasks
     *  (offscreen RTTs, post-FX, UI overlays, etc.). */
    /** @internal */
    _frameGraph: FrameGraph;

    /** @internal Optional clustered point-light container. Only populated by the clustered-light extension API. */
    _clusteredLightContainer?: ClusteredLightContainer;
    /** @internal Updates clustered light cells for the camera used by the current render pass. */
    _clusteredLightUpdater?: (camera: Camera | null | undefined, targetWidth: number, targetHeight: number) => void;
}

/** Options passed to the scene-context factory. */
export interface SceneContextOptions {
    defaultRenderTask?: boolean;
}

/** Queue a mesh for renderable (re)build on the next frame's material-swap drain.
 *  Shared by the material setter (runtime material change) and addToScene (runtime
 *  mesh add). Lazily loads the swap processor so scenes that never mutate at runtime
 *  don't pull it into their bundle. */
function enqueueMaterialSwap(scene: SceneContext, mesh: Mesh): void {
    const mi = mesh as Mesh;
    if (mi._materialDirty) {
        return;
    }
    mi._materialDirty = true;
    scene._materialSwapQueue.push(mesh);
    if (!scene._processSwaps) {
        void import("./scene-material-swap.js").then((m) => {
            scene._processSwaps = m.processMaterialSwaps;
        });
    }
}

/** Install a property setter on mesh.material that sets _materialDirty
 *  and pushes the mesh into the scene's swap queue for processing. */
function installMaterialSetter(scene: SceneContext, mesh: Mesh): void {
    let _mat = mesh.material;
    Object.defineProperty(mesh, "material", {
        get() {
            return _mat;
        },
        set(v) {
            if (v !== _mat) {
                _mat = v;
                enqueueMaterialSwap(scene, mesh);
            }
        },
        configurable: true,
        enumerable: true,
    });
}

/** Create an empty scene context bound to the given engine. */
export function createSceneContext(engine: EngineContext, options?: SceneContextOptions): SceneContext {
    const eng = engine as EngineContext;

    // Closures below capture `ctx` by-reference via this object.
    const ctxLocal: Omit<SceneContext, "_frameGraph"> = {
        engine,
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
        _gsMeshes: [],
        _uniformUpdaters: [],
        fixedDeltaMs: 0,
        _beforeRender: [],
        _deferredBuilders: [],
        _groups: new Map(),
        _disposables: [],
        _meshDisposables: new Map(),
        _materialSwapQueue: [],
        _renderableVersion: 0,
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
            if (ctx._materialSwapQueue.length > 0) {
                ctx._processSwaps?.(ctx);
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
        const swapRT = createRenderTarget({
            label: "scene-swapchain",
            colorFormat: eng.format,
            depthStencilFormat: "depth24plus-stencil8",
            sampleCount: eng.msaaSamples,
            size: "canvas",
            resolveToSwapchain: true,
        });
        _appendTask(
            fg,
            createRenderTask(
                {
                    name: "scene",
                    rt: swapRT,
                    clrColor: ctx.clearColor,
                },
                eng,
                ctx
            )
        );
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
        const built = await build(ctx.engine as EngineContext, ctx);
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
            const engine = ctx.engine as EngineContext;
            const groups = result.animationGroups;
            ctx.animationGroups.push(...groups);
            ctx._beforeRender.push((deltaMs: number) => {
                for (const g of groups) {
                    if (!g._stopped && g._ctrl) {
                        g._ctrl.tick(deltaMs, engine);
                    }
                }
            });
        }
        return;
    }
    if ("_gpu" in entity && "material" in entity) {
        const mesh = entity as unknown as Mesh;
        ctx.meshes.push(mesh);
        installMaterialSetter(ctx, mesh);
        const build = mesh.material ? (mesh.material as unknown as { _buildGroup?: MeshGroupBuilder })._buildGroup : undefined;
        if (build) {
            let group = ctx._groups.get(build);
            if (!group) {
                group = [];
                ctx._groups.set(build, group);
                ctx._deferredBuilders.push(async () => {
                    const result = await build(ctx, group!);
                    ctx._renderables.push(...result.renderables);
                    if (result.updater) {
                        ctx._uniformUpdaters.push(result.updater);
                    }
                });
            }
            group.push(mesh);
            // Added after the initial build: the deferred builder for this group has
            // already run (and only runs at boot), so materialize this mesh's renderable
            // through the per-frame material-swap drain instead.
            if (ctx._built) {
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
    unregisterRenderingContext(ctx.engine, ctx);
    for (const fn of ctx._disposables) {
        fn();
    }
    for (const fns of ctx._meshDisposables.values()) {
        for (const fn of fns) {
            fn();
        }
    }
    ctx._meshDisposables.clear();
    for (const mesh of ctx.meshes) {
        disposeMeshGpu(mesh);
    }
    ctx.meshes.length = 0;
    ctx._renderables.length = 0;
    ctx._prePasses.length = 0;
    ctx._gsMeshes.length = 0;
    ctx._uniformUpdaters.length = 0;
    ctx._beforeRender.length = 0;
    ctx._deferredBuilders.length = 0;
    ctx._disposables.length = 0;
    ctx._materialSwapQueue.length = 0;
    ctx.lights.length = 0;
    ctx.animationGroups.length = 0;
    ctx.shadowGenerators.length = 0;
    ctx.camera = null;
}

/** @internal Run all deferred builders (called by registerScene's boot step before the first frame). */
export async function buildScene(scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContext;
    while (ctx._deferredBuilders.length > 0) {
        const builders = [...ctx._deferredBuilders];
        ctx._deferredBuilders = [];
        await Promise.all(builders.map(async (b) => b()));
    }
    for (const mesh of ctx._materialSwapQueue) {
        (mesh as Mesh)._materialDirty = false;
    }
    ctx._materialSwapQueue.length = 0;
    ctx._renderableVersion++;
    ctx._built = true;
}

/**
 * Register a scene with the engine. Builds deferred work, sorts renderables by order,
 * and adds the scene to the engine's render list in overlay order.
 */
export async function registerScene(engine: EngineContext, scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContext;
    if (isRenderingContextRegistered(engine, ctx)) {
        return;
    }
    await buildScene(scene);
    ctx._renderables.sort(byOrder);
    await Promise.all(ctx._frameGraph._tasks.map((task) => task._preload?.()).filter((preload): preload is Promise<void> => preload !== undefined));
    ctx._frameGraph.build();
    if ((engine as EngineContext)._renderingContexts.length > 0) {
        (await import("./swapchain-overlay.js")).configureSwapchainOverlayScene(engine as EngineContext, ctx);
    }
    registerRenderingContext(engine, ctx);
}

/**
 * Register a scene with the engine and install the scene-owned shadow frame-graph task.
 * Use only for scenes that generate shadow maps.
 */
export async function registerSceneWithShadowSupport(engine: EngineContext, scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContext;
    if (isRenderingContextRegistered(engine, ctx)) {
        return;
    }
    await buildScene(scene);
    ctx._renderables.sort(byOrder);
    await ensureShadowTask(engine as EngineContext, ctx);
    await Promise.all(ctx._frameGraph._tasks.map((task) => task._preload?.()).filter((preload): preload is Promise<void> => preload !== undefined));
    ctx._frameGraph.build();
    if ((engine as EngineContext)._renderingContexts.length > 0) {
        (await import("./swapchain-overlay.js")).configureSwapchainOverlayScene(engine as EngineContext, ctx);
    }
    registerRenderingContext(engine, ctx);
}

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;

async function ensureShadowTask(engine: EngineContext, scene: SceneContext): Promise<void> {
    const { createShadowTask } = await import("../frame-graph/shadow-task.js");
    scene._frameGraph._tasks.unshift(createShadowTask(engine, scene));
}

/** Remove a previously-registered scene. Idempotent. Does not dispose scene resources. */
export function unregisterScene(engine: EngineContext, scene: SceneContext): void {
    unregisterRenderingContext(engine, scene as SceneContext);
}
