import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { Camera } from "../camera/camera.js";
import type { LightBase } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshInternal } from "../mesh/mesh.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";
import type { FogConfig } from "../material/standard/standard-material.js";
import type { Renderable, PrePassRenderable, MeshGroupBuilder } from "../render/renderable.js";
import type { TransformNode } from "./transform-node.js";
import type { SceneNode } from "./scene-node.js";
import type { SkyboxData } from "../loader-skybox/load-skybox.js";
import type { EnvironmentTextures } from "../loader-env/load-env.js";
import type { AssetContainer } from "../asset-container.js";
import type { FrameGraph } from "../frame-graph/frame-graph.js";
import { createFrameGraph, addRenderPassTask } from "../frame-graph/frame-graph.js";
import { createRenderTarget } from "../engine/render-target.js";
import type { RenderPassTask } from "../frame-graph/render-pass-task.js";
import { createRenderPassTask, addRenderableToTask, removeMeshFromTask } from "../frame-graph/render-pass-task.js";

/** Image processing configuration. */
export interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
    /** "standard" (BJS TONEMAPPING_STANDARD, default) or "aces" (BJS TONEMAPPING_ACES). */
    toneMappingType?: "standard" | "aces";
}

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

    /** Shadow generators registered on this scene. */
    shadowGenerators: ShadowGenerator[];

    /** Background material primaryColor (linear RGB). Default from Babylon createDefaultEnvironment. */
    environmentPrimaryColor?: [number, number, number];

    /** Environment cubemap Y rotation in radians. */
    envRotationY?: number;

    /** Fixed delta time in ms for deterministic animation. 0 = use real rAF delta. */
    fixedDeltaMs: number;
}

/** @internal SceneContext with internal rendering state — for renderable/loader code only. Not re-exported from index.ts. */
export interface SceneContextInternal extends SceneContext {
    /** Pre-pass work (shadow maps, compute, etc.). */
    _prePasses: PrePassRenderable[];
    /** Fixed delta time in ms for deterministic animation. 0 = use real rAF delta. */
    _fixedDeltaMs: number;
    /** Per-frame callbacks run before rendering (animation, physics, etc.). */
    _beforeRender: ((deltaMs: number) => void)[];
    /** Internal per-frame callbacks run by the engine just before executing the frame graph
     *  (lights UBO updates, mesh-group GPU updates, etc.). Distinct from `_beforeRender`
     *  which is the user-facing pre-render hook with `deltaMs`. */
    _perFrameCallbacks: (() => void)[];
    /** Scene-level renderables — populated by entity adders (`addToScene`) and loaders.
     *  Render pass tasks with `autoFromScene = true` mirror this list at `record()` time. */
    _renderables: Renderable[];
    /** Scene-level deferred builders. Drained by the engine at the top of each `renderFrame`
     *  BEFORE any frame graph build. Builders may push more builders (multi-round trampoline)
     *  to enforce ordering between batched/group builders and consumers (e.g. env background
     *  needs PBR ctx that the PBR mesh-group builder installs). */
    _builders: (() => void | Promise<void>)[];
    /** Mesh group registry — maps builder to its mesh list (internal bookkeeping). */
    _groups: Map<MeshGroupBuilder, Mesh[]>;

    // ─── Dispose infrastructure ────────────────────────────────
    /** Shared cleanup callbacks (scene UBOs, lights UBOs, etc.). Registered by builders. */
    _disposables: (() => void)[];
    /** Per-mesh cleanup callbacks (mesh UBOs, bind groups). For material swap + dispose. */
    _meshDisposables: Map<Mesh, (() => void)[]>;
    /** Meshes whose material was changed via setter — drained before each render frame. */
    _materialSwapQueue: Mesh[];
    /** Cache: Renderable per (mesh, material) pair, shared across all passes that include it.
     *  Same mesh + same material in N passes → one Renderable. Different material → distinct
     *  Renderables (each with its own meshUBO/materialUBO/BG). Evicted on material swap and
     *  on `removeFromScene` / `disposeScene`. */
    _meshRenderable: WeakMap<Mesh, Map<unknown, Renderable>>;
    /** Whether this scene has been disposed. */
    _disposed: boolean;

    // ─── Stashed internal state (typed to avoid `as any` casts) ────
    _skybox?: SkyboxData;
    _envTextures?: EnvironmentTextures;
    _irradianceSH?: Float32Array;

    /** Lazy render-hook inserted between pre-passes and the main render pass. The hook may
     *  finish & submit `enc`, do extra GPU work (e.g., opaque-scene RTT + mipmap), and must
     *  return the encoder that the main pass should record into. Installed by the lazy
     *  refraction module only; core renderFrame is hook-free for non-transmissive scenes. */
    _beforeMain?: (engine: EngineContext, scene: SceneContextInternal, enc: GPUCommandEncoder) => GPUCommandEncoder;

    /** Frame graph — automatically created and managed. Drives all GPU rendering. */
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
                }
            }
        },
        configurable: true,
        enumerable: true,
    });
}

/** Create an empty scene context bound to the given engine. */
export function createSceneContext(engine: EngineContext): SceneContext {
    const eng = engine as EngineContextInternal;

    // Build the main render target. The render pass task and frame graph need
    // the scene context (to capture engine + scene), so they're created after ctx.
    const mainRT = createRenderTarget({
        label: "main",
        colorFormat: eng.format,
        depthStencilFormat: "depth24plus-stencil8",
        sampleCount: eng.msaaSamples,
        size: "canvas",
        resolveToSwapchain: true,
    });

    // Stable backing object for clearColor — mutated in place by the setter so any
    // task holding a reference (e.g. the main render pass task) sees user updates
    // even when the user assigns `scene.clearColor = { ... }` (which would otherwise
    // replace the reference and leave tasks pointing at stale values).
    const clearColorBacking: GPUColorDict = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    const ctx: SceneContextInternal = {
        engine,
        get clearColor(): GPUColorDict {
            return clearColorBacking;
        },
        set clearColor(v: GPUColorDict) {
            clearColorBacking.r = v.r;
            clearColorBacking.g = v.g;
            clearColorBacking.b = v.b;
            clearColorBacking.a = v.a;
        },
        camera: null,
        lights: [],
        meshes: [],
        animationGroups: [],
        fog: null,
        shadowGenerators: [],
        imageProcessing: { exposure: 1.0, contrast: 1.0, toneMappingEnabled: false },
        _prePasses: [],
        _fixedDeltaMs: 0,
        get fixedDeltaMs(): number {
            return ctx._fixedDeltaMs;
        },
        set fixedDeltaMs(v: number) {
            ctx._fixedDeltaMs = v;
        },
        _beforeRender: [],
        _perFrameCallbacks: [],
        _renderables: [],
        _builders: [],
        _groups: new Map(),
        _disposables: [],
        _meshDisposables: new Map(),
        _materialSwapQueue: [],
        _meshRenderable: new WeakMap(),
        _disposed: false,
        // _frameGraph assigned just below — needs ctx to exist so it can capture it as its scene reference.
        _frameGraph: null as unknown as FrameGraph,
    };

    ctx._frameGraph = createFrameGraph(eng, ctx);
    // Main pass auto-mirrors scene._renderables at record() time when its own list is empty.
    const mainTask = createRenderPassTask({ name: "main", renderTarget: mainRT, autoFromScene: true }, eng, ctx);
    mainTask.clearColor = ctx.clearColor;
    addRenderPassTask(ctx._frameGraph, mainTask);

    return ctx;
}

/** Get the scene's frame graph. Exposed for multi-pass authoring (adding RTT
 *  passes via `addRenderPassTask` / `addRenderPassTaskAtStart`). */
export function getFrameGraph(scene: SceneContext): FrameGraph {
    return (scene as SceneContextInternal)._frameGraph;
}

/** @internal Push a renderable into the scene-level renderables list. Render pass tasks
 *  with `autoFromScene = true` mirror this list when they record. */
export function addRenderable(scene: SceneContext, r: Renderable): void {
    (scene as SceneContextInternal)._renderables.push(r);
}

/** @internal Push multiple renderables into the scene-level renderables list. */
export function addRenderables(scene: SceneContext, rs: readonly Renderable[]): void {
    (scene as SceneContextInternal)._renderables.push(...rs);
}

/** @internal Get the cached Renderable for `(mesh, material)`, or build it via `factory` and cache it.
 *  The cache lives on the scene, so the same `(mesh, material)` pair shared across multiple passes
 *  produces ONE Renderable (and therefore one mesh UBO + one material UBO/BG). Evicted on material
 *  swap and mesh removal. */
export function getOrBuildMeshRenderable(scene: SceneContext, mesh: Mesh, material: unknown, factory: (s: SceneContext, m: Mesh, mat: unknown) => Renderable): Renderable {
    const ctx = scene as SceneContextInternal;
    let inner = ctx._meshRenderable.get(mesh);
    if (!inner) {
        inner = new Map();
        ctx._meshRenderable.set(mesh, inner);
    }
    let r = inner.get(material);
    if (!r) {
        r = factory(scene, mesh, material);
        inner.set(material, r);
    }
    return r;
}

/** @internal Register a per-frame callback run by the engine just before executing the frame graph. */
export function addPerFrameCallback(scene: SceneContext, cb: () => void): void {
    (scene as SceneContextInternal)._perFrameCallbacks.push(cb);
}

/** @internal Register a deferred builder on the scene. Drained by the engine in `renderFrame`
 *  before any frame graph build. Builders may push more builders to enforce ordering. */
export function addDeferredBuilder(scene: SceneContext, builder: () => void | Promise<void>): void {
    (scene as SceneContextInternal)._builders.push(builder);
}

/** @internal Drain scene-level builders. Loops until the queue is empty so that builders
 *  that push more builders (multi-round trampoline) are fully resolved. */
export async function drainSceneBuilders(scene: SceneContextInternal): Promise<void> {
    while (scene._builders.length > 0) {
        const builders = scene._builders.splice(0);
        await Promise.all(builders.map(async (b) => b()));
    }
}

/** Register a callback to run before each rendered frame. */
export function onBeforeRender(scene: SceneContext, cb: (deltaMs: number) => void): void {
    (scene as SceneContextInternal)._beforeRender.unshift(cb);
}

/** Add an entity (mesh, light, camera, transform node, shadow generator, or asset container) to the scene. */
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
        const build = mesh.material ? ((mesh.material as any)._buildGroup as MeshGroupBuilder | undefined) : undefined;
        if (build) {
            let group = ctx._groups.get(build);
            if (!group) {
                group = [];
                ctx._groups.set(build, group);
                addDeferredBuilder(scene, async () => {
                    const result = await build(ctx, group!);
                    addRenderables(scene, result.renderables);
                    addPerFrameCallback(scene, result.update);
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
    if (ctx._disposed) {
        return;
    }
    ctx._disposed = true;
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
    ctx._prePasses.length = 0;
    ctx._beforeRender.length = 0;
    ctx._perFrameCallbacks.length = 0;
    ctx._renderables.length = 0;
    ctx._builders.length = 0;
    ctx._disposables.length = 0;
    ctx._materialSwapQueue.length = 0;
    ctx.lights.length = 0;
    ctx.animationGroups.length = 0;
    ctx.shadowGenerators.length = 0;
    ctx.camera = null;
}

/** @internal Drain _materialSwapQueue: dispose old resources and rebuild renderables. */
export function processMaterialSwaps(scene: SceneContext): void {
    const ctx = scene as SceneContextInternal;
    const eng = ctx.engine as EngineContextInternal;
    const q = ctx._materialSwapQueue;
    for (const mesh of q) {
        (mesh as MeshInternal)._materialDirty = false;

        // Fast path: the mesh's cached renderable is already for the current material
        // (the swap was queued before any renderable was built — drainSceneBuilders has
        // since built the renderable directly for the new material). Nothing to do.
        const innerMap = ctx._meshRenderable.get(mesh);
        const currentMat = mesh.material;
        if (currentMat && innerMap?.has(currentMat)) {
            continue;
        }

        // Evict the old renderable from scene._renderables and from every render pass task.
        if (innerMap) {
            for (const r of innerMap.values()) {
                const idx = ctx._renderables.indexOf(r);
                if (idx >= 0) {
                    ctx._renderables.splice(idx, 1);
                }
            }
        }
        for (const t of ctx._frameGraph._tasks) {
            if ("renderTarget" in t) {
                removeMeshFromTask(t as RenderPassTask, mesh);
            }
        }
        ctx._meshRenderable.delete(mesh);

        const old = ctx._meshDisposables.get(mesh);
        if (old) {
            for (const fn of old) {
                fn();
            }
            ctx._meshDisposables.delete(mesh);
        }

        const mat = mesh.material;
        const builder = mat ? (mat as any)._buildGroup : undefined;
        const rebuild = builder?._rebuildSingle;
        if (rebuild && mat) {
            const renderable = getOrBuildMeshRenderable(ctx, mesh, mat, rebuild);
            ctx._renderables.push(renderable);
            // Mirror into auto-from-scene tasks so this frame's execute sees the new renderable
            // (auto-mirror is sticky — it only refills empty task lists at record() time).
            for (const t of ctx._frameGraph._tasks) {
                if ("renderTarget" in t && (t as RenderPassTask).autoFromScene) {
                    addRenderableToTask(t as RenderPassTask, eng, renderable);
                }
            }
        }
    }
    q.length = 0;
}
