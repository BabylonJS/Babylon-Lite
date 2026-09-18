/**
 * Shared render-pass execution and automatic scene rendering. This module
 * borrows renderables; the public render-task factory adds explicit ownership.
 *
 *   - `record()` builds bucketed `DrawBinding` lists from `_renderables`
 *     (opaque / direct / transparent), sorts opaque + direct by
 *     `order`, then creates a `RenderPass` wired to the task's render target.
 *     The pass owns its
 *     `GPURenderPassDescriptor` and the per-pass-encoder body lives in a
 *     closure passed to `setRenderPassExecuteFunc`.
 *   - Before `RenderPass._execute()` begins the GPU pass: writes the scene UBO, refreshes lights, updates
 *     per-binding UBOs, mirrors live `scene.clearColor` + `clr` onto the
 *     render pass. Shared task execution then calls `_execute()`. The
 *     `RenderPass` itself patches the swapchain view + clearColor + loadOp
 *     and brackets the body with `beginRenderPass` / `end`.
 *
 * Renderable population:
 *   - Explicit: `addMeshToTask(task, mesh, opts)` builds a (mesh, material)
 *     Renderable at `record()` time and selects explicit population.
 *   - Auto scene mirror: copy the scene's renderables until explicit ownership entries exist.
 *     Re-sync happens automatically when the scene's
 *     `_renderableVersion` changes between frames (mesh add/remove, material swap).
 *
 * The engine `scRT` is just another `RenderTarget` here: a task that
 * targets it (`rt`) or resolves into it (`rst`) re-reads its per-frame color view
 * at execute time (the swap texture is re-acquired each frame). `clr: false`
 * preserves color content, while `depthClear: false` preserves rt-owned depth,
 * so multiple tasks can share a target in one frame.
 */

import { F32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import { _vis } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Camera } from "../camera/camera.js";
import type { Renderable, DrawBinding, DrawUpdateContext } from "../render/renderable.js";
import type { DrawBatchState } from "../render/draw-update-batches.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Material } from "../material/material.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { getViewMatrix, _cameraChangeKey } from "../camera/camera.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { _packSceneUniforms } from "./scene-uniforms-pack.js";
import { createEmptyUniformBuffer } from "../resource/empty-uniform-buffer.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import { ensureSceneLightState, refreshSceneLightsUBO } from "../render/scene-lights-ubo.js";
import type { Task } from "./task.js";

/** Configuration for `createRenderTask`: render target, clear state, optional camera override, and transmission settings. */
export interface RenderTaskConfig {
    name: string;
    /** TODO: rt should not live in this config long-term. Until texture
     *  management is virtualized, callers must provide the concrete target; once
     *  virtualized, the task should create/manage its own render target. */
    rt: RenderTarget;
    /** Optional single-sample resolve target. When `rt` is multisampled
     *  (`sampleCount > 1`), the color attachment resolves into this target's
     *  color texture at end-of-pass — letting an MSAA render feed a post-process
     *  that requires a single-sample source, without an extra resolve pass.
     *  Caller contract (not validated): must be single-sample with a color
     *  format and size matching `rt`; WebGPU errors at pass-encode time if not.
     *  Ignored when `rt` is single-sample. */
    rst?: RenderTarget;
    /** Optional separate depth/stencil attachment. The pass binds this target's
     *  depth view instead of `rt`'s own, and uses its `depthStencilFormat` for
     *  pipeline signature matching. The colour `rt` must omit `depthStencilFormat`
     *  (so it allocates no internal depth) and match this target in size + sample
     *  count. Two ownership modes, distinguished by `_eager`:
     *  - `_eager` depth (e.g. a `GeometryRendererTask` output): the task neither
     *    builds nor clears nor disposes it — it loads it (`loadOp: "load"`) and the
     *    caller owns clearing. This is how scenes reuse a pre-rendered depth buffer.
     *  - non-`_eager` depth: the task owns it — builds/rebuilds it in `record()`,
     *    clears it (`loadOp: "clear"`), and disposes it. Used by the default
     *    single-sample scene task, whose colour `rt` is the depth-less
     *    engine `scRT`. */
    depth?: RenderTarget;
    /** Background clear color. May be mutated frame-to-frame. */
    clrColor?: GPUColorDict;
    /** When true, color `loadOp` is "clear"; when false, "load" (overlays previous
     *  color content). Depth is cleared when rt-owned (unless `depthClear: false`) and
     *  follows the eager/task-managed ownership policy when supplied via `depth`. */
    clr?: boolean;
    /** rt-owned depth `loadOp`. Default true = "clear" (unchanged behaviour). Set false so an
     *  overlay task drawn into another task's target LOADS that target's existing depth and can
     *  depth-test against the scene already rendered there. Ignored when `depth` is supplied
     *  (an external depth is always loaded when eager, task-managed otherwise). */
    depthClear?: boolean;
    /** This task draws into a target OWNED BY ANOTHER TASK: it neither builds nor disposes `rt`/
     *  `rst` (the owner does; `record()` here only wires the pass to the owner's live views, so
     *  the owning task must be recorded first — place this task after it). Pair with `clr: false`
     *  and `depthClear: false` for a full overlay pass. Default false. */
    sharedRt?: boolean;
    /** Per-pass camera override. Null/undefined uses `scene.camera`. */
    cam?: Camera | null;
    /** Use canvas dimensions, not render-target dimensions, for this pass's scene UBO aspect. */
    cs?: boolean;
    /** Scene-texture transmission settings. `copyCount: 0` copies before every transmissive draw.
     *  `generateMipmaps: false` allocates only mip 0 for the refraction texture and skips mip generation.
     *  `mipLevelCount` caps the generated chain when a material only samples low explicit LODs.
     *  `grabDepth: true` also snapshots the task's DEPTH attachment at the same mid-pass grab (see
     *  `TransmissionOptions.grabDepth`). */
    transmission?: { copyCount?: number; generateMipmaps?: boolean; mipLevelCount?: number; grabDepth?: boolean };
    /** Set false for an explicit render list that never auto-mirrors the scene's renderables,
     *  even while the task list is empty. Undefined preserves the default auto-mirror behavior. */
    autoMirror?: boolean;
    /** @internal Skip clustered-light preparation for passes that never run forward lighting. */
    _skipClusteredLights?: boolean;
}

/** A frame-graph task that records a single `RenderPass`, binds the scene's `RenderTarget`, and draws renderables into it. */
export interface RenderTask extends Task {
    readonly name: string;
    /** App-driven execute gate, default true. When false the pass is skipped entirely — no
     *  attachment load, no MSAA resolve, no draws. The owner that KNOWS the task's content toggles
     *  this (e.g. when its last mesh hides); the engine never scans bindings to decide. Disabling a
     *  task that owns its target leaves the target's previous content stale — meant for overlay
     *  tasks (`sharedRt`/`clr: false`), where skipping is a semantic no-op. */
    enabled?: boolean;
    /** Render tasks are scene-bound because they consume scene camera, lights, and renderables. */
    readonly scene: SceneContext;
    /** Live task configuration. Mutating `clr` or `clrColor` affects subsequent frames. */
    /** @internal */
    readonly _config: RenderTaskConfig;
    /** @internal Target ownership is fixed when the task is created. */
    readonly _ownsTargets: boolean;
    /** @internal Source renderables for the active draw generation. */
    _renderables: Renderable[];
    /** @internal */
    _opaqueBindings: DrawBinding[];
    /** @internal */
    _directBindings: DrawBinding[];
    /** @internal */
    _transparentBindings: DrawBinding[];
    /** @internal Cached opaque bundle generation. */
    _ob: GPURenderBundle[];
    /** @internal Scene version captured before building the active bindings, not when drawing them. */
    _lastVersion: number;
    /** @internal */
    _lastVis?: number;
    /** @internal Optional feature-owned update work for the active generation. */
    _batchState?: DrawBatchState;
    /** @internal */
    _disposed?: boolean;
    /** @internal Optional task-owned population extension, invoked only within a candidate generation. */
    _prepareTaskMeshes?(candidate: RenderTaskPopulation, commit?: boolean): void;
    /** @internal Optional explicit record path installed with mesh population. */
    _recordExplicit?(task: RenderTask, record: boolean): void;
    /** @internal Auxiliary ownership release installed only with explicit mesh population. */
    _retireRenderable?(engine: EngineContext, renderable: Renderable): void;
    /** @internal */
    _renderPassDescriptor: GPURenderPassDescriptor;
    /** @internal */
    _colorAttachment: GPURenderPassColorAttachment;

    /** Per-task scene UBO, written by `_writePassSceneUBO` and destroyed in `dispose()`.
     *  The scene bind group and shared light buffer are resolved when recording starts. */
    /** @internal */
    _sceneUBO: GPUBuffer;
    /** @internal Task-owned scene bind group, also used as the recovery discriminator. */
    _sceneBG?: GPUBindGroup;
    /** @internal Shared light buffer captured by `_sceneBG`. */
    _lightsUBO?: GPUBuffer;
    /** @internal */
    _suData: Float32Array;
    /** @internal */
    _sceneUboCacheKey: unknown[];
    /** Optional transmission-enabled execute path: copies the scene texture for refraction and draws transmissive
     *  renderables. Present only when the task was configured with `transmission`. Returns the number of draw calls issued. */
    /** @internal */
    _executeWithTransmission?(sampleCount: number): number;
    /** @internal */
    _targetSignature: RenderTargetSignature;
    /** @internal Pass dimensions and camera shared with binding updates. */
    _updateContext: MutableDrawUpdateContext;
    /** @internal Optional explicit mesh-population strategy, installed by addMeshToTask. */
    _addMesh?(mesh: Mesh, opts?: { material?: Material }): void;
    /** @internal Optional refresh source-list removal hook. */
    _removeMesh?(mesh: object): void;
    /** @internal */
    _pendingMeshes?: TaskMeshRequest[];
}

/** @internal Off-task source inputs prepared before binding. */
export interface RenderTaskPopulation {
    readonly scene: SceneContext;
    /** @internal */
    _renderables: Renderable[];
    /** @internal */
    _pendingMeshes: TaskMeshRequest[];
}

/** @internal Off-task draw values published only after preparation succeeds. */
export interface RenderTaskBindingGeneration {
    /** @internal */
    _renderables: Renderable[];
    /** @internal */
    _opaqueBindings: DrawBinding[];
    /** @internal */
    _directBindings: DrawBinding[];
    /** @internal */
    _transparentBindings: DrawBinding[];
    /** @internal */
    _ob: GPURenderBundle[];
    /** @internal */
    _lastVersion: number;
    /** @internal */
    _lastVis?: number;
    /** @internal */
    _batchState?: DrawBatchState;
}

/** @internal One queued explicit mesh/material request. */
export interface TaskMeshRequest {
    mesh: Mesh;
    material?: Material;
}

interface MutableDrawUpdateContext {
    targetWidth: number;
    targetHeight: number;
    _camera?: Camera | null;
}

function createBindingGeneration(renderables: Renderable[], version: number): RenderTaskBindingGeneration {
    return {
        _renderables: renderables,
        _opaqueBindings: [],
        _directBindings: [],
        _transparentBindings: [],
        _ob: [],
        _lastVersion: version,
    };
}

/** @internal A render-only task: automatic scene passes do not own auxiliary mesh entries. */
export type RenderTaskBase = Omit<RenderTask, "_pendingMeshes" | "_prepareTaskMeshes">;

/** Create a render pass task. GPU resources (target textures + descriptor)
 *  are not allocated until `record()` runs (via `frameGraph.build()`).
 *
 *  Swapchain-targeted tasks acquire the swap view per-frame at execute time.
 *  @internal Automatic tasks borrow renderables and do not expose explicit mesh population. */
export function _createAutomaticRenderTask(config: RenderTaskConfig, engine: EngineContext, scene: SceneContext): RenderTaskBase {
    config.clr ??= true;
    const desc = config.rt._descriptor;
    const depthDesc = config.depth?._descriptor;
    // Render upright: row 0 of the GPU texture is the top of the scene. Every
    // RT (offscreen or swapchain) renders without a projection Y-flip; pipelines
    // use the default ccw front face; downstream samplers see upright pixels.
    const targetSignature = {
        _colorFormat: desc.format,
        _depthStencilFormat: depthDesc?.dFormat ?? desc.dFormat,
        _depthCompare: desc.depthCompare ?? depthDesc?.depthCompare,
        _sampleCount: desc.samples,
    };

    const colorAttachment = { loadOp: "clear", storeOp: "store" } as GPURenderPassColorAttachment;
    const updateContext: MutableDrawUpdateContext = { targetWidth: 0, targetHeight: 0 };
    const task: RenderTaskBase = {
        ...createBindingGeneration([], -1),
        name: config.name,
        _config: config,
        _ownsTargets: !config.sharedRt,
        engine: engine,
        scene,
        _passes: [],
        _renderPassDescriptor: { colorAttachments: [colorAttachment] },
        _colorAttachment: colorAttachment,
        _sceneUBO: createEmptyUniformBuffer(engine, SCENE_UBO_BYTES),
        _suData: new F32(SCENE_UBO_BYTES / 4),
        _sceneUboCacheKey: [],
        _targetSignature: targetSignature,
        _updateContext: updateContext,
        record(): void {
            if (task._disposed) {
                throw new Error("RenderTask has been disposed.");
            }
            if (task._recordExplicit) {
                task._recordExplicit(task, true);
            } else {
                _buildBindings(task, config.autoMirror !== false ? scene._renderables.slice() : task._renderables, true);
            }
        },
        execute(): number {
            return executePass(task, engine, targetSignature);
        },
        dispose(): void {
            if (task._disposed) {
                return;
            }
            task._disposed = true;
            const pending = (task as RenderTask)._pendingMeshes;
            if (pending) {
                pending.length = 0;
            }
            for (const renderable of task._renderables) {
                task._retireRenderable?.(task.engine, renderable);
            }
            task._passes.length = task._opaqueBindings.length = task._directBindings.length = 0;
            task._transparentBindings.length = task._renderables.length = task._ob.length = 0;
            // Sampled eager targets release their writer lease. Swapchain and geometry
            // wrappers remain externally owned, as do shared targets and eager external depth.
            if (task._ownsTargets) {
                disposeRenderTarget(config.rt);
                disposeRenderTarget(config.rst);
            }
            if (!config.depth?._eager) {
                disposeRenderTarget(config.depth);
            }
            const buffer = task._sceneUBO;
            retireGpuResources(task.engine, () => buffer.destroy());
            task._batchState?._release(task.engine);
            task._batchState = undefined;
        },
    };
    return task;
}

/** Remove a mesh from this task's renderable + binding lists. Idempotent. */
export function _removeMeshFromRenderTask(task: RenderTaskBase, mesh: object): void {
    // Not a renderable-bearing task (e.g. a post/effect task that also carries `_config`): nothing to
    // remove. Guard keeps callers that scan all frame-graph tasks (removeFromScene) shape-safe.
    if (!task._renderables) {
        return;
    }
    task._removeMesh?.(mesh);
    let removed = false;
    for (let i = task._renderables.length - 1; i >= 0; i--) {
        if (task._renderables[i]!.mesh === mesh) {
            task._retireRenderable?.(task.engine, task._renderables[i]!);
            task._renderables.splice(i, 1);
            removed = true;
        }
    }
    for (const arr of [task._opaqueBindings, task._directBindings, task._transparentBindings]) {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i]!.renderable.mesh === mesh) {
                arr.splice(i, 1);
                removed = true;
            }
        }
    }
    if (removed) {
        const previous = task._batchState;
        task._batchState = previous?._select([task._opaqueBindings, task._directBindings, task._transparentBindings]);
        previous?._release(task.engine, [task._batchState]);
        task._ob.length = 0;
        task._lastVersion = -1;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

function compareTransparentBindings(a: DrawBinding, b: DrawBinding): number {
    return b._sortDistance! - a._sortDistance! || a.renderable.order - b.renderable.order;
}

function compareBindingOrder(a: DrawBinding, b: DrawBinding): number {
    return a.renderable.order - b.renderable.order;
}

/** Per-frame back-to-front sort for transparent bindings using the active camera. */
function sortTransparentBindings(task: RenderTaskBase, camera: Camera | null | undefined): void {
    const arr = task._transparentBindings;
    if (arr.length <= 1 || !camera) {
        return;
    }
    const v = getViewMatrix(camera);
    for (const b of arr) {
        const wc = b.renderable._worldCenter;
        b._sortDistance = wc ? wc[0]! * v[2]! + wc[1]! * v[6]! + wc[2]! * v[10]! + v[14]! : 0;
    }
    arr.sort(compareTransparentBindings);
}

/** @internal Build and publish a complete binding generation. Explicit candidates defer retirement until task publication. */
export function _buildBindings(
    task: RenderTaskBase,
    renderables = task._renderables,
    record = false,
    publish = true,
    retainedOnFailure?: readonly (DrawBatchState | undefined)[]
): RenderTaskBindingGeneration {
    const config = task._config;
    const rt = config.rt;
    const previousBatchState = task._batchState;
    const generation = createBindingGeneration(renderables, task.scene._renderableVersion);
    if (record) {
        const buildTarget = (target: RenderTarget | undefined, always?: boolean): void => {
            if (target && (always || task._ownsTargets || target._eager)) {
                buildRenderTarget(target, task.engine);
            }
        };
        buildTarget(rt);
        if (rt._descriptor.samples > 1) {
            buildTarget(config.rst);
        }
        buildTarget(config.depth, true);
    }
    const { _opaqueBindings: opaque, _directBindings: direct, _transparentBindings: transparent } = generation;
    try {
        for (const renderable of renderables) {
            const binding = renderable.bind(task.engine, task._targetSignature);
            generation._batchState = task._targetSignature._collectBatches?.(generation._batchState, binding);
            if (renderable.isTransparent || renderable._transmissive) {
                transparent.push(binding);
            } else if (renderable._direct) {
                direct.push(binding);
            } else {
                opaque.push(binding);
            }
        }
        opaque.sort(compareBindingOrder);
        direct.sort(compareBindingOrder);
        if (record) {
            refreshTaskSceneBindGroup(task, task.engine, false);
        }
    } catch (error) {
        generation._batchState?._release(undefined, retainedOnFailure ?? [previousBatchState]);
        throw error;
    }
    if (record) {
        buildRenderPassDescriptor(task, rt);
        task._updateContext.targetWidth = rt._width;
        task._updateContext.targetHeight = rt._height;
    }
    if (publish) {
        Object.assign(task, generation);
        previousBatchState?._release(task.engine, [generation._batchState]);
    }
    return generation;
}

function buildRenderPassDescriptor(task: RenderTaskBase, rt: RenderTarget): void {
    const config = task._config;
    const att = task._colorAttachment;
    att.view = rt._colorView!;
    // End-of-pass MSAA resolve into a caller-supplied single-sample target.
    // executePass wires the resolve target immediately before every pass so
    // swapchain targets pick up their current per-frame view.
    task._renderPassDescriptor.colorAttachments = rt._colorView ? [att] : [];

    const depthSrc = config.depth ?? rt;
    const depthView = depthSrc._depthView;
    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (depthView) {
        const dd = depthSrc._descriptor;
        const loadOp = (config.depth ? depthSrc._eager : config.depthClear === false) ? "load" : "clear";
        depthAttachment = {
            view: depthView,
            depthClearValue: dd.depthClearValue ?? 0,
            depthLoadOp: loadOp,
            depthStoreOp: "store",
        };
        if (dd.dFormat?.includes("stencil")) {
            depthAttachment.stencilClearValue = 0;
            depthAttachment.stencilLoadOp = loadOp;
            depthAttachment.stencilStoreOp = "store";
        }
    }

    task._renderPassDescriptor.depthStencilAttachment = depthAttachment;
}

function prepareRenderTaskPass(task: RenderTaskBase, eng: EngineContext, targetSignature: RenderTargetSignature): void {
    const sc = task.scene as SceneContext;
    // Auto-resync when the source scene mutates.
    if (task._config.autoMirror !== false && task._lastVersion !== sc._renderableVersion) {
        _buildBindings(task, sc._renderables.slice());
    }

    // Pre-pass work — runs before beginRenderPass. Updates the task-owned scene
    // UBO, scene-wide lights UBO, and per-binding UBOs. The scene bind group may
    // also need a refresh (lights buffer can be resized when glTF lights
    // extension raises MAX_LIGHTS after this task was first recorded).
    refreshTaskSceneBindGroup(task, eng);
    const context = task._updateContext;
    const camera = task._config.cam ?? sc.camera;
    // Depth-only passes use no-colour views, so only colour passes need scene-light work.
    if (targetSignature._colorFormat) {
        if (!task._config._skipClusteredLights) {
            sc._clusteredLightUpdater?.(camera, context.targetWidth, context.targetHeight);
        }
        refreshSceneLightsUBO(eng, sc);
    }
    _writePassSceneUBO(task, eng, sc, camera);
    // Expose the active camera to per-binding `update()` calls. Some renderables
    // (e.g. transparent billboard systems) need it to compute view-space sort
    // depths during their update.
    (context as MutableDrawUpdateContext)._camera = camera;
    task._batchState?._reset();
    updateBindings(task._opaqueBindings, context);
    updateBindings(task._directBindings, context);
    updateBindings(task._transparentBindings, context);
    task._batchState?._flush(eng);
    // Per-frame back-to-front sort for transparent bindings — must run AFTER
    // updateBindings so renderables that compute `_worldCenter` inside their
    // own `update()` (billboard systems) are seen with current values.
    sortTransparentBindings(task, camera);
}

function executePass(task: RenderTaskBase, eng: EngineContext, targetSignature: RenderTargetSignature): number {
    if (task.enabled === false) {
        return 0;
    }
    const sc = task.scene;
    prepareRenderTaskPass(task, eng, targetSignature);
    const att = task._colorAttachment;
    const cfg = task._config;
    if (cfg.rt._colorView) {
        // This scene's surface scRT color view is re-acquired every frame, so re-read it
        // here. Checking the bound surface (not the engine's primary scRT) is required for
        // auxiliary createSurface scenes. Offscreen color views are stable between rebuilds
        // — leaving att.view untouched preserves an external override (swapchain-overlay
        // shares the base scene's MSAA color view). The resolve target (rst) is re-read each
        // frame so an `rst === scRT` picks up its fresh per-frame view.
        if (cfg.rt === sc.surface.scRT) {
            att.view = cfg.rt._colorView;
        }
        att.resolveTarget = cfg.rst?._colorView ?? undefined;
        att.clearValue = cfg.clrColor ?? sc.clearColor;
        att.loadOp = cfg.clr ? "clear" : "load";
    }
    if (task._executeWithTransmission) {
        return task._executeWithTransmission(targetSignature._sampleCount);
    }
    const pass = eng._currentEncoder.beginRenderPass(task._renderPassDescriptor);
    const draws = executePassBody(task, pass);
    pass.end();
    return draws;
}

/** Body of the registered `RenderPass`. Receives the live render-pass encoder
 *  and issues all draws (viewport/scissor, group(0) bind, opaque bundle replay,
 *  then direct-draws non-transparent direct + transparent). Returns the draw count. */
function executePassBody(task: RenderTaskBase, pass: GPURenderPassEncoder): number {
    const eng = task.engine as EngineContext;
    const cfg = task._config;
    const rt = cfg.rt;
    const scene = task.scene as SceneContext;
    const opaqueBindings = task._opaqueBindings;
    const opaqueBundles = task._ob;
    const sceneBG = task._sceneBG!;

    const camera = cfg.cam ?? scene.camera;
    const v = camera?.viewport;
    if (v) {
        const rw = rt._width;
        const rh = rt._height;
        const x = Math.floor(v.x * rw);
        const y = Math.floor((1 - v.y - v.height) * rh);
        const w = Math.ceil((v.x + v.width) * rw) - x;
        const h = Math.ceil((1 - v.y) * rh) - y;
        pass.setViewport(x, y, w, h, 0, 1);
        pass.setScissorRect(x, y, w, h);
    }
    // Scene bind group (group 0) is task-owned and identical for every draw in this pass.
    pass.setBindGroup(0, sceneBG);

    // Binding publication clears the bundle. Visibility/resource changes invalidate it without
    // overwriting the source version that automatic binding synchronization still needs.
    if (task._lastVis !== _vis || !opaqueBundles.length) {
        const desc = rt._descriptor;
        const be = eng._device.createRenderBundleEncoder({
            colorFormats: desc.format ? [desc.format] : [],
            // Use the task's target signature, not the RT descriptor: a depth
            // override (config.depth) supplies the depth format externally, so
            // the cached opaque pipelines are built with it while the colour RT
            // carries no depthStencilFormat of its own. The bundle encoder's
            // attachment state must match those pipelines exactly.
            depthStencilFormat: task._targetSignature._depthStencilFormat,
            sampleCount: desc.samples,
        });
        be.setBindGroup(0, sceneBG);
        drawList(be, opaqueBindings, eng);
        opaqueBundles[0] = be.finish();
        task._lastVis = _vis;
    }
    let draws = opaqueBindings.length;
    pass.executeBundles(opaqueBundles);
    // executeBundles invalidates pass bind-group state — rebind group 0 before further draws.
    pass.setBindGroup(0, sceneBG);
    draws += drawList(pass, task._directBindings, eng);
    draws += drawList(pass, task._transparentBindings, eng);
    return draws;
}

function refreshTaskSceneBindGroup(task: RenderTaskBase, eng: EngineContext, invalidateBundles = true): void {
    const lightsUBO = ensureSceneLightState(eng, task.scene as SceneContext)._buffer;
    if (lightsUBO === task._lightsUBO) {
        return;
    }
    const sceneBG = eng._device.createBindGroup({
        layout: getSceneBindGroupLayout(eng),
        entries: [
            { binding: 0, resource: { buffer: task._sceneUBO } },
            { binding: 1, resource: { buffer: lightsUBO } },
        ],
    });
    task._lightsUBO = lightsUBO;
    task._sceneBG = sceneBG;
    if (invalidateBundles) {
        task._ob = [];
    }
}

/** Write the canonical SceneUniforms struct to the task-owned scene UBO.
 *  Bails before touching scratch/GPU when all inputs are unchanged.
 *  @internal Exported for unit testing of the scene-UBO change-detection guard. */
export function _writePassSceneUBO(task: RenderTaskBase, eng: EngineContext, scene: SceneContext, camera: Camera | null): void {
    if (!camera) {
        return;
    }

    const v = camera.viewport;
    const rt = task._config.rt;
    const aspect = (task._config.cs ? eng.canvas.width / eng.canvas.height : rt._width / rt._height) * (v ? v.width / v.height : 1);
    const fog = scene.fog;
    const img = scene.imageProcessing;
    // Change key = camera transform version + projection revision, the latter covering both
    // `fov` / `nearPlane` / `farPlane` writes and orthographic bounds. See `_cameraChangeKey`.
    const wv = _cameraChangeKey(camera);
    // `envTextures` identity is tracked so an environment loaded (or swapped) AFTER the scene has reached
    // steady state invalidates this cache. Its spherical-harmonics irradiance and `lodGenerationScale` are
    // written into the scene UBO below (via `_packSceneUniforms` + the env-SH contributor); without tracking
    // it, a late env load would change none of the other guarded inputs, so the UBO would never be rewritten
    // and the model would keep zero irradiance (dark diffuse, specular-only "mirror" look).
    const envTextures = scene._envTextures;
    const s = task._sceneUboCacheKey;
    if (s[0] === camera && s[1] === fog && s[2] === wv && s[3] === aspect && s[4] === img.exposure && s[5] === img.contrast && s[6] === envTextures) {
        return;
    }
    s[0] = camera;
    s[1] = fog;
    s[2] = wv;
    s[3] = aspect;
    s[4] = img.exposure;
    s[5] = img.contrast;
    s[6] = envTextures;

    const data = task._suData;
    _packSceneUniforms(data, eng, scene, camera, aspect);
    const contribs = scene._sceneUboContributors;
    if (contribs) {
        for (const contributor of contribs) {
            contributor(data, scene);
        }
    }
    eng._device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
}

function updateBindings(list: readonly DrawBinding[], context: DrawUpdateContext): void {
    for (const binding of list) {
        binding.update?.(context);
    }
}

/** @internal Iterate DrawBindings, deduping setPipeline. */
export function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly DrawBinding[], engine: EngineContext): number {
    let lp: GPURenderPipeline | null = null;
    let draws = 0;
    for (const b of list) {
        const mesh = b.renderable.mesh;
        if (mesh && mesh.visible === false) {
            continue;
        }
        if (b.pipeline !== lp) {
            enc.setPipeline(b.pipeline);
            lp = b.pipeline;
        }
        draws += b.draw(enc, engine);
    }
    return draws;
}
