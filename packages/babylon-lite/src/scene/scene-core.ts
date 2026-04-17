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
import type { Renderable, PrePassRenderable, SceneUniformUpdater, MeshGroupBuilder } from "../render/renderable.js";
import type { TransformNode } from "./transform-node.js";
import type { SceneNode } from "./scene-node.js";
import type { SkyboxData } from "../loader-skybox/load-skybox.js";
import type { EnvironmentTextures } from "../loader-env/load-env.js";
import type { ComposedShader } from "../shader/fragment-types.js";
import type { AssetContainer } from "../asset-container.js";

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
    /** Sorted list of renderables. Built lazily by startEngine(). */
    _renderables: Renderable[];
    /** Opaque renderables — sorted by order at build time. */
    _opaqueRenderables: Renderable[];
    /** Transparent renderables — sorted per-frame by camera distance (back-to-front). */
    _transparentRenderables: Renderable[];
    /** Pre-pass work (shadow maps, compute, etc.). */
    _prePasses: PrePassRenderable[];
    /** Scene uniform updaters (one per shared UBO). */
    _uniformUpdaters: SceneUniformUpdater[];
    /** Fixed delta time in ms for deterministic animation. 0 = use real rAF delta. */
    _fixedDeltaMs: number;
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
    /** Whether this scene has been disposed. */
    _disposed: boolean;
    /** Monotonic counter bumped when the renderable list changes (add/remove/rebuild). */
    _renderableVersion: number;

    // ─── Stashed internal state (typed to avoid `as any` casts) ────
    _skybox?: SkyboxData;
    _envTextures?: EnvironmentTextures;
    _irradianceSH?: Float32Array;
    _pbrSceneBGL?: GPUBindGroupLayout;
    _pbrSceneBG?: GPUBindGroup;
    _composePbr?: (features: number, features2?: number) => ComposedShader;
    _standardSceneUBO?: GPUBuffer;
    _pbrLightsUBO?: GPUBuffer;
    _pbrLightsUBOScratch?: Float32Array;
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
    const ctx: SceneContextInternal = {
        engine,
        clearColor: { r: 0.2, g: 0.2, b: 0.3, a: 1.0 },
        camera: null,
        lights: [],
        meshes: [],
        animationGroups: [],
        fog: null,
        shadowGenerators: [],
        imageProcessing: { exposure: 1.0, contrast: 1.0, toneMappingEnabled: false },
        _renderables: [],
        _opaqueRenderables: [],
        _transparentRenderables: [],
        _prePasses: [],
        _uniformUpdaters: [],
        _fixedDeltaMs: 0,
        get fixedDeltaMs(): number {
            return ctx._fixedDeltaMs;
        },
        set fixedDeltaMs(v: number) {
            ctx._fixedDeltaMs = v;
        },
        _beforeRender: [],
        _deferredBuilders: [],
        _groups: new Map(),
        _disposables: [],
        _meshDisposables: new Map(),
        _materialSwapQueue: [],
        _disposed: false,
        _renderableVersion: 0,
    };
    return ctx;
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
                ctx._deferredBuilders.push(async () => {
                    const result = await build(ctx, group!);
                    ctx._renderables.push(...result.renderables);
                    ctx._uniformUpdaters.push(result.updater);
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
    ctx._renderables.length = 0;
    ctx._opaqueRenderables.length = 0;
    ctx._transparentRenderables.length = 0;
    ctx._prePasses.length = 0;
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

/** @internal Run all deferred builders (called by startEngine before the render loop). */
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

/** @internal Drain _materialSwapQueue: dispose old resources and rebuild renderables. */
export function processMaterialSwaps(scene: SceneContext): void {
    const ctx = scene as SceneContextInternal;
    const q = ctx._materialSwapQueue;
    for (const mesh of q) {
        (mesh as MeshInternal)._materialDirty = false;
        const old = ctx._meshDisposables.get(mesh);
        if (old) {
            for (const fn of old) {
                fn();
            }
            ctx._meshDisposables.delete(mesh);
        }

        const mat = mesh.material;
        const builder = mat ? (mat as any)._buildGroup : undefined;
        if (!builder) {
            continue;
        }
        const rebuild = builder._rebuildSingle;
        if (rebuild) {
            const renderable = rebuild(ctx, mesh);
            if (renderable.isTransparent) {
                ctx._transparentRenderables.push(renderable);
            } else {
                const arr = ctx._opaqueRenderables;
                let i = arr.length;
                while (i > 0 && arr[i - 1]!.order > renderable.order) {
                    i--;
                }
                arr.splice(i, 0, renderable);
            }
        } else if (builder._loadRebuildSingle) {
            builder._loadRebuildSingle().then((mod: any) => {
                builder._rebuildSingle = mod.buildSinglePbrRenderable ?? mod.buildSingleStandardRenderable;
                (mesh as MeshInternal)._materialDirty = true;
                ctx._materialSwapQueue.push(mesh);
            });
        }
    }
    q.length = 0;
    ctx._renderableVersion++;
}
