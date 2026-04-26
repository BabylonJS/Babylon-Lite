import type { EngineContext, RenderingContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { _vis } from "../engine/engine.js";
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
export interface SceneContextInternal extends SceneContext, RenderingContext {
    /** Sorted list of renderables. Built lazily by registerScene(). */
    _renderables: Renderable[];
    /** Opaque renderables — sorted by order at build time. */
    _opaqueRenderables: Renderable[];
    /** Transmissive renderables — opaque (write-depth) but need the opaque-scene RTT as input.
     *  Rendered after _opaqueRenderables and before _transparentRenderables in the main pass;
     *  when non-empty the engine also runs the opaque-scene pre-pass. */
    _transmissiveRenderables: Renderable[];
    /** Transparent renderables — sorted per-frame by camera distance (back-to-front). */
    _transparentRenderables: Renderable[];
    /** Pre-pass work (shadow maps, compute, etc.). */
    _prePasses: PrePassRenderable[];
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
    _skybox?: SkyboxData;
    _envTextures?: EnvironmentTextures;
    _irradianceSH?: Float32Array;
    _pbrSceneBGL?: GPUBindGroupLayout;
    _pbrSceneBG?: GPUBindGroup;
    _composePbr?: (features: number, features2?: number) => ComposedShader;
    _standardSceneUBO?: GPUBuffer;
    _pbrLightsUBO?: GPUBuffer;
    _pbrLightsUBOScratch?: Float32Array;

    /** Lazy render-hook inserted between pre-passes and the main render pass. The hook may
     *  finish & submit `enc`, do extra GPU work (e.g., opaque-scene RTT + mipmap), and must
     *  return the encoder that the main pass should record into. Installed by the lazy
     *  refraction module only; core renderFrame is hook-free for non-transmissive scenes. */
    _beforeMain?: (engine: EngineContext, scene: SceneContextInternal, enc: GPUCommandEncoder) => GPUCommandEncoder;
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
export function createSceneContext(engine: EngineContext): SceneContext {
    const eng = engine as EngineContextInternal;
    let opaqueBundle: GPURenderBundle | null = null;
    let bundleVersion = -1;
    let bundleVis = 0;

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
        _transmissiveRenderables: [],
        _transparentRenderables: [],
        _prePasses: [],
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

        _update(encoder: GPUCommandEncoder, delta: number): GPUCommandEncoder {
            const d = ctx.fixedDeltaMs > 0 ? ctx.fixedDeltaMs : delta;
            let draws = 0;
            for (const cb of ctx._beforeRender) {
                cb(d);
            }
            if (ctx._materialSwapQueue.length > 0) {
                ctx._processSwaps?.(ctx);
            }
            for (const light of ctx.lights) {
                if (light.shadowGenerator) {
                    draws += light.shadowGenerator.renderShadowMap(encoder);
                }
            }
            for (const pp of ctx._prePasses) {
                draws += pp.execute(encoder, eng);
            }
            for (const u of ctx._uniformUpdaters) {
                u.update(eng);
            }
            for (const r of ctx._renderables) {
                if (r.updateUBOs) {
                    r.updateUBOs();
                }
            }
            const cam = ctx.camera;
            if (ctx._transparentRenderables.length > 1 && cam) {
                const w = cam.worldMatrix;
                const cx = w[12]!,
                    cy = w[13]!,
                    cz = w[14]!;
                for (const r of ctx._transparentRenderables) {
                    if (r._worldCenter) {
                        const [wx, wy, wz] = r._worldCenter;
                        r._sortDistance = (wx - cx) ** 2 + (wy - cy) ** 2 + (wz - cz) ** 2;
                    }
                }
                ctx._transparentRenderables.sort((a, b) => (b._sortDistance ?? 0) - (a._sortDistance ?? 0) || a.order - b.order);
            }
            if (ctx._beforeMain) {
                encoder = ctx._beforeMain(eng, ctx, encoder);
            }
            ctx._drawCallsPre = draws;
            return encoder;
        },
        _record(pass: GPURenderPassEncoder): number {
            if (bundleVersion !== ctx._renderableVersion || bundleVis !== _vis || !opaqueBundle) {
                const be = eng.device.createRenderBundleEncoder({
                    colorFormats: [eng.format],
                    depthStencilFormat: "depth24plus-stencil8",
                    sampleCount: eng.msaaSamples,
                });
                drawList(be, ctx._opaqueRenderables, eng);
                opaqueBundle = be.finish();
                bundleVersion = ctx._renderableVersion;
                bundleVis = _vis;
            }
            let draws = ctx._opaqueRenderables.length;
            pass.executeBundles([opaqueBundle]);
            draws += drawList(pass, ctx._transmissiveRenderables, eng);
            draws += drawList(pass, ctx._transparentRenderables, eng);
            return draws;
        },
    };
    return ctx;
}

function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly Renderable[], engine: EngineContextInternal): number {
    let lp: GPURenderPipeline | null = null;
    let lb: GPUBindGroup | null = null;
    let draws = 0;
    for (const r of list) {
        if (r.mesh && r.mesh.visible === false) {
            continue;
        }
        if (r._pipeline && r._pipeline !== lp) {
            enc.setPipeline(r._pipeline);
            lp = r._pipeline;
        }
        if (r._sceneBG && r._sceneBG !== lb) {
            enc.setBindGroup(0, r._sceneBG);
            lb = r._sceneBG;
        }
        draws += r.draw(enc, engine);
        if (!r._pipeline) {
            lp = null;
        }
        if (!r._sceneBG) {
            lb = null;
        }
    }
    return draws;
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
    const eng = ctx.engine as EngineContextInternal;
    const i = eng._renderingContexts.indexOf(ctx);
    if (i >= 0) {
        eng._renderingContexts.splice(i, 1);
    }
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
    ctx._transmissiveRenderables.length = 0;
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
 * Register a scene with the engine. Builds deferred work, partitions renderables,
 * and adds the scene to the engine's render list in overlay order.
 */
export async function registerScene(engine: EngineContext, scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContextInternal;
    await buildScene(scene);
    for (const r of ctx._renderables) {
        const bucket = r.isTransparent ? ctx._transparentRenderables : r.isTransmissive ? ctx._transmissiveRenderables : ctx._opaqueRenderables;
        bucket.push(r);
    }
    ctx._opaqueRenderables.sort(byOrder);
    ctx._transmissiveRenderables.sort(byOrder);
    ctx._renderables.sort(byOrder);
    (engine as EngineContextInternal)._renderingContexts.push(ctx);
}

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;

/** Remove a previously-registered scene. Idempotent. Does not dispose scene resources. */
export function unregisterScene(engine: EngineContext, scene: SceneContext): void {
    const eng = engine as EngineContextInternal;
    const i = eng._renderingContexts.indexOf(scene as SceneContextInternal);
    if (i >= 0) {
        eng._renderingContexts.splice(i, 1);
    }
}
