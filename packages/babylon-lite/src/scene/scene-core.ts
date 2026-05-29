import type { EngineContext, RenderingContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { _vis, isRenderingContextRegistered, registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { Camera } from "../camera/camera.js";
import type { LightBase } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshInternal } from "../mesh/mesh.js";
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
import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";

/** Image processing configuration. */
export interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
    /** "standard" (BJS TONEMAPPING_STANDARD, default) or "aces" (BJS TONEMAPPING_ACES). */
    toneMappingType?: "standard" | "aces";
}

export type ClipPlane = readonly [number, number, number, number];

/** Top-level scene context — pure state, no attached methods. */
export interface SceneContext {
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

    /** Scene clip plane as (normal.x, normal.y, normal.z, d). Matches Babylon.js Plane dot(worldPosition, plane) > 0 discard semantics. */
    clipPlane: ClipPlane | null;

    /** Shadow generators registered on this scene. */
    shadowGenerators: ShadowGenerator[];

    /** Background material primaryColor (linear RGB). Default from Babylon createDefaultEnvironment. */
    environmentPrimaryColor?: [number, number, number];

    /** Environment cubemap Y rotation in radians. */
    envRotationY?: number;

    /** Fixed delta time in ms for deterministic animation. 0 = use real rAF delta. */
    fixedDeltaMs: number;
}

export interface SceneContextOptions {
    defaultRenderTask?: boolean;
}

/** @internal SceneContext with internal rendering state — for renderable/loader code only. Not re-exported from index.ts. */
export interface SceneContextInternal extends SceneContext, RenderingContext {
    /** All renderables in this scene. The active frame-graph tasks bucket them
     *  (opaque / direct / transparent) at bind time based on `isTransparent`, `_direct`, and `_transmissive`. */
    _renderables: Renderable[];
    /** Pre-pass work (shadow maps, compute, etc.). */
    _prePasses: PrePassRenderable[];
    /** GaussianSplatting meshes attached to this scene.  Populated by
     *  `attachGaussianSplattingMesh`.  Scene-core stays GS-agnostic apart from
     *  this opaque registry (used by `gpu-picker` to iterate GS meshes without
     *  scanning `_renderables`). */
    _gsMeshes: GaussianSplattingMesh[];
    /** Scene uniform updaters (one per shared UBO). */
    _uniformUpdaters: SceneUniformUpdater[];
    /** Per-frame callbacks run before rendering (animation, physics, etc.). */
    _beforeRender: ((deltaMs: number) => void)[];
    /** Deferred builders — registered by loaders/factories, run once at startEngine(). */
    _deferredBuilders: (() => void | Promise<void>)[];
    /** Mesh group registry — maps builder to its mesh list (internal bookkeeping). */
    _groups: Map<MeshGroupBuilder, Mesh[]>;

    // ─── Dispose infrastructure ────────────────────────────────
    /** Shared cleanup callbacks (scene UBOs, lights UBOs, etc.). Registered by builders. */
    _disposables: (() => void)[];
    /** Per-mesh cleanup callbacks (mesh UBOs, bind groups). For material swap + dispose. */
    _meshDisposables: Map<Mesh, (() => void)[]>;
    /** Meshes whose material was changed via setter — drained before each render frame. */
    _materialSwapQueue: Mesh[];
    /** Monotonic counter bumped when the renderable list changes (add/remove/rebuild). */
    _renderableVersion: number;
    /** Lazily-loaded processor; populated on first material reassignment. */
    _processSwaps?: (scene: SceneContext) => void;

    // ─── Stashed internal state (typed to avoid `as any` casts) ────
    _envTextures?: EnvironmentTextures;
    /** Scene-owned shared LightsUniforms UBO state (group 0 binding 1). */
    _lightGpuState?: SceneLightGpuState;

    /** Frame graph driving this scene's rendering. Created eagerly by
     *  `createSceneContext` with a default `RenderTask` that mirrors
     *  `_renderables` into the swapchain. User code may add additional tasks
     *  (offscreen RTTs, post-FX, UI overlays, etc.). */
    _frameGraph: FrameGraph;
}

/** Install a property setter on mesh.material that sets _materialDirty
 *  and pushes the mesh into the scene's swap queue for processing. */
function installMaterialSetter(scene: SceneContextInternal, mesh: Mesh): void {
    const mi = mesh as MeshInternal;
    let _mat = mesh.material;
    Object.defineProperty(mesh, "material", {
        get() {
            return _mat;
        },
        set(v) {
            if (v !== _mat) {
                _mat = v;
                if (!mi._materialDirty) {
                    mi._materialDirty = true;
                    scene._materialSwapQueue.push(mesh);
                    if (!scene._processSwaps) {
                        void import("./scene-material-swap.js").then((m) => {
                            scene._processSwaps = m.processMaterialSwaps;
                        });
                    }
                }
            }
        },
        configurable: true,
        enumerable: true,
    });
}

/** Create an empty scene context bound to the given engine. */
export function createSceneContext(engine: EngineContext, options?: SceneContextOptions): SceneContext {
    const eng = engine as EngineContextInternal;

    // Closures below capture `ctx` by-reference via this object.
    const ctxLocal: Omit<SceneContextInternal, "_frameGraph"> = {
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
        _drawCallsPre: 0,

        _update(): void {
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

    const ctx = ctxLocal as SceneContextInternal;
    // Eagerly attach the frame graph + a default swapchain render-pass task. The
    // graph drives all GPU work for this scene; user code can add more tasks
    // (offscreen RTTs, post-FX, UI overlays) before/after.
    const fg = createFrameGraph(eng, ctx);
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
    (scene as SceneContextInternal)._beforeRender.unshift(cb);
}

/** Register a callback to run when `disposeScene` is called. Used to tie
 *  user-owned GPU resources (e.g. a `SpriteRenderer`) to the scene's lifetime. */
export function onSceneDispose(scene: SceneContext, cb: () => void): void {
    (scene as SceneContextInternal)._disposables.push(cb);
}

/** Get the scene's frame graph. Always non-null — created in `createSceneContext`. */
export function getFrameGraph(scene: SceneContext): FrameGraph {
    return (scene as SceneContextInternal)._frameGraph;
}

export interface DeferredSceneRenderables {
    renderables: readonly Renderable[];
    dispose?: () => void;
}

/** @internal Register optional scene-hosted render work without teaching `addToScene` about the feature. */
export function addDeferredSceneRenderables(
    scene: SceneContext,
    build: (engine: EngineContextInternal, scene: SceneContextInternal) => DeferredSceneRenderables | Promise<DeferredSceneRenderables>
): void {
    const ctx = scene as SceneContextInternal;
    ctx._deferredBuilders.push(async () => {
        const built = await build(ctx.engine as EngineContextInternal, ctx);
        ctx._renderables.push(...built.renderables);
        if (built.dispose) {
            ctx._disposables.push(built.dispose);
        }
    });
}

export function addToScene(scene: SceneContext, entity: Mesh | LightBase | Camera | ShadowGenerator | TransformNode | AssetContainer): void {
    const ctx = scene as SceneContextInternal;
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
            const engine = ctx.engine as EngineContextInternal;
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
        const build = mesh.material?._buildGroup;
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
    const ctx = scene as SceneContextInternal;
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
    const ctx = scene as SceneContextInternal;
    while (ctx._deferredBuilders.length > 0) {
        const builders = [...ctx._deferredBuilders];
        ctx._deferredBuilders = [];
        await Promise.all(builders.map(async (b) => b()));
    }
    for (const mesh of ctx._materialSwapQueue) {
        (mesh as MeshInternal)._materialDirty = false;
    }
    ctx._materialSwapQueue.length = 0;
    ctx._renderableVersion++;
}

/**
 * Register a scene with the engine. Builds deferred work, sorts renderables by order,
 * and adds the scene to the engine's render list in overlay order.
 */
export async function registerScene(engine: EngineContext, scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContextInternal;
    if (isRenderingContextRegistered(engine, ctx)) {
        return;
    }
    await buildScene(scene);
    ctx._renderables.sort(byOrder);
    await Promise.all(ctx._frameGraph._tasks.map((task) => task._preload?.()).filter((preload): preload is Promise<void> => preload !== undefined));
    ctx._frameGraph.build();
    if ((engine as EngineContextInternal)._renderingContexts.length > 0) {
        (await import("./swapchain-overlay.js")).configureSwapchainOverlayScene(engine as EngineContextInternal, ctx);
    }
    registerRenderingContext(engine, ctx);
}

/**
 * Register a scene with the engine and install the scene-owned shadow frame-graph task.
 * Use only for scenes that generate shadow maps.
 */
export async function registerSceneWithShadowSupport(engine: EngineContext, scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContextInternal;
    if (isRenderingContextRegistered(engine, ctx)) {
        return;
    }
    await buildScene(scene);
    ctx._renderables.sort(byOrder);
    await ensureShadowTask(engine as EngineContextInternal, ctx);
    await Promise.all(ctx._frameGraph._tasks.map((task) => task._preload?.()).filter((preload): preload is Promise<void> => preload !== undefined));
    ctx._frameGraph.build();
    if ((engine as EngineContextInternal)._renderingContexts.length > 0) {
        (await import("./swapchain-overlay.js")).configureSwapchainOverlayScene(engine as EngineContextInternal, ctx);
    }
    registerRenderingContext(engine, ctx);
}

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;

async function ensureShadowTask(engine: EngineContextInternal, scene: SceneContextInternal): Promise<void> {
    const { createShadowTask } = await import("../frame-graph/shadow-task.js");
    scene._frameGraph._tasks.unshift(createShadowTask(engine, scene));
}

/** Remove a previously-registered scene. Idempotent. Does not dispose scene resources. */
export function unregisterScene(engine: EngineContext, scene: SceneContext): void {
    unregisterRenderingContext(engine, scene as SceneContextInternal);
}
