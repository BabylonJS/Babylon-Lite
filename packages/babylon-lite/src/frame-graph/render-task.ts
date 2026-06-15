/**
 * RenderTask — a frame-graph task that records a single `RenderPass`,
 * binds the scene's `RenderTarget`, and draws renderables into it.
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
 *   - Explicit: push into `_renderables` directly, or `addMesh(mesh, opts)`
 *     which builds a (mesh, material) Renderable at `record()` time.
 *   - Auto scene mirror: when `_renderables` is empty at record() time, copy the
 *     scene's renderables. Re-sync happens automatically when the scene's
 *     `_renderableVersion` changes between frames (mesh add/remove, material swap).
 *
 * The engine `scRT` is just another `RenderTarget` here: a task that
 * targets it (`rt`) or resolves into it (`rst`) re-reads its per-frame color view
 * at execute time (the swap texture is re-acquired each frame). `clr: false`
 * switches color + depth `loadOp` to `"load"` so multiple scenes can share the
 * swapchain in one frame (e.g., a 3D scene + a UI overlay scene).
 */

import { F32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import { _vis } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Camera } from "../camera/camera.js";
import type { Renderable, DrawBinding, DrawUpdateContext } from "../render/renderable.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Material } from "../material/material.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { getViewMatrix } from "../camera/camera.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { _packSceneUniforms } from "./scene-uniforms-pack.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import { ensureSceneLightState, refreshSceneLightsUBO } from "../render/lights-ubo.js";
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
     *  color content). Depth is always cleared when rt-owned and always loaded when
     *  supplied via `depth`. */
    clr?: boolean;
    /** Per-pass camera override. Null/undefined uses `scene.camera`. */
    cam?: Camera | null;
    /** Use canvas dimensions, not render-target dimensions, for this pass's scene UBO aspect. */
    cs?: boolean;
    /** Scene-texture transmission settings. `copyCount: 0` copies before every transmissive draw.
     *  `generateMipmaps: false` allocates only mip 0 for the refraction texture and skips mip generation.
     *  `mipLevelCount` caps the generated chain when a material only samples low explicit LODs. */
    transmission?: { copyCount?: number; generateMipmaps?: boolean; mipLevelCount?: number };
}

/** A frame-graph task that records a single `RenderPass`, binds the scene's `RenderTarget`, and draws renderables into it. */
export interface RenderTask extends Task {
    readonly name: string;
    /** Render tasks are scene-bound because they consume scene camera, lights, and renderables. */
    readonly scene: SceneContext;
    /** Live task configuration. Mutating `clr` or `clrColor` affects subsequent frames. */
    /** @internal */
    readonly _config: RenderTaskConfig;
    /** @internal */
    _autoFromScene: boolean;

    /** Source-of-truth renderables. Bucketed binding lists below are derived from
     *  this list at `record()` (or re-sync when auto-filled and `_renderableVersion` changes). */
    /** @internal */
    _renderables: Renderable[];
    /** @internal */
    _opaqueBindings: DrawBinding[];
    /** @internal */
    _directBindings: DrawBinding[];
    /** @internal */
    _transparentBindings: DrawBinding[];
    /** Cached opaque render bundle. Invalidated by renderable list mutations
     *  (`_lastVersion`) and visibility changes (`_lastVis`). */
    /** @internal */
    _opaqueBundles: GPURenderBundle[];
    /** @internal */
    _lastVersion: number;
    /** @internal */
    _lastVis: number;

    /** @internal */
    _renderPassDescriptor: GPURenderPassDescriptor;
    /** @internal */
    _colorAttachment: GPURenderPassColorAttachment;
    /** @internal External depth source from `config.depth`. When unset,
     *  the pass uses `config.rt._depthView`. */
    _depthSrc?: RenderTarget;
    /** @internal External depth/stencil `loadOp` ("load" when `config.depth` is
     *  set). When unset, defaults to `"clear"`. */
    _depthLoadOp?: GPULoadOp;

    /** Per-task scene UBO + bind group. Created eagerly in createRenderTask
     *  so renderables can reference `_sceneBG` at `bind()` time. Written each
     *  frame by `writePassSceneUBO`. Destroyed in `dispose()`. */
    /** @internal */
    _sceneUBO: GPUBuffer;
    /** @internal */
    _sceneBG: GPUBindGroup;
    /** @internal */
    _lightsUBO: GPUBuffer;
    /** @internal */
    _suData: Float32Array;
    /** @internal */
    _su: unknown[];
    /** Optional transmission-enabled execute path: copies the scene texture for refraction and draws transmissive
     *  renderables. Present only when the task was configured with `transmission`. Returns the number of draw calls issued. */
    /** @internal */
    _executeWithTransmission?(sampleCount: number): number;
    /** @internal */
    _targetSignature: RenderTargetSignature;

    /** Add a mesh to this task's explicit render list with an optional per-pass material override.
     *  Resolved at `record()` time via `material._buildGroup._rebuildSingle`,
     *  so the mesh's material family must already have been registered with
     *  the scene (so its batch builder has run). */
    addMesh(mesh: Mesh, opts?: { material?: Material }): void;
    /** @internal */
    _pendingMeshes: { mesh: Mesh; material: Material }[];
}

interface MutableDrawUpdateContext {
    targetWidth: number;
    targetHeight: number;
    _camera?: Camera | null;
}

/** Create a render pass task. GPU resources (target textures + descriptor)
 *  are not allocated until `record()` runs (via `frameGraph.build()`).
 *
 *  Swapchain-targeted tasks acquire the swap view per-frame at execute time. */
export function createRenderTask(config: RenderTaskConfig, engine: EngineContext, scene: SceneContext): RenderTask {
    const sc = scene as SceneContext;
    config.clrColor ??= { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    config.clr ??= true;
    const desc = config.rt._descriptor;
    // Render upright: row 0 of the GPU texture is the top of the scene. Every
    // RT (offscreen or swapchain) renders without a projection Y-flip; pipelines
    // use the default ccw front face; downstream samplers see upright pixels.
    const targetSignature = {
        _colorFormat: desc.format,
        _depthStencilFormat: config.depth?._descriptor.dFormat ?? desc.dFormat,
        _depthCompare: desc._depthCompare,
        _sampleCount: desc.samples ?? 1,
    };

    const sceneBGL = getSceneBindGroupLayout(engine);
    const sceneUBO = createEmptyUniformBuffer(engine, SCENE_UBO_BYTES);
    const lightsUBO = ensureSceneLightState(engine, sc)._buffer;
    const sceneBG = engine._device.createBindGroup({
        layout: sceneBGL,
        entries: [
            { binding: 0, resource: { buffer: sceneUBO } },
            { binding: 1, resource: { buffer: lightsUBO } },
        ],
    });
    const colorAttachment = { loadOp: "clear", storeOp: "store" } as GPURenderPassColorAttachment;
    const updateContext: MutableDrawUpdateContext = { targetWidth: 0, targetHeight: 0 };
    const task: RenderTask = {
        name: config.name,
        _config: config,
        engine: engine,
        scene: sc,
        _passes: [],
        _autoFromScene: false,
        _renderables: [],
        _opaqueBindings: [],
        _directBindings: [],
        _transparentBindings: [],
        _opaqueBundles: [],
        _lastVersion: -1,
        _lastVis: 0,
        _renderPassDescriptor: { colorAttachments: [colorAttachment] },
        _colorAttachment: colorAttachment,
        _depthSrc: config.depth,
        _depthLoadOp: config.depth ? (config.depth._eager ? "load" : "clear") : undefined,
        _sceneUBO: sceneUBO,
        _sceneBG: sceneBG,
        _lightsUBO: lightsUBO,
        _suData: new F32(SCENE_UBO_BYTES / 4),
        _su: [],
        _targetSignature: targetSignature,
        _pendingMeshes: [],
        addMesh(mesh, opts) {
            const material = opts?.material ?? mesh.material;
            if (!material) {
                return;
            }
            task._pendingMeshes.push({ mesh, material });
        },
        record(): void {
            if (task._autoFromScene) {
                task._renderables.length = 0;
            }
            resolvePendingMeshes(task, sc);
            task._autoFromScene = task._renderables.length === 0;
            if (task._autoFromScene) {
                task._renderables.push(...sc._renderables);
            }
            // Read config.rt dynamically — transmission retargeting swaps it after
            // the task is created, and the engine scRT must never be rebuilt.
            const rt = config.rt;
            buildRenderTarget(rt, engine);
            if (config.rst && (rt._descriptor.samples ?? 1) > 1) {
                buildRenderTarget(config.rst, engine);
            }
            // A non-eager external depth (e.g. the default single-sample scene task's
            // depth, whose colour rt is the depth-less scRT) is task-managed:
            // build/rebuild it here. Eager depths (GeometryRendererTask outputs) are
            // pre-built and skipped by buildRenderTarget.
            if (config.depth && !config.depth._eager) {
                buildRenderTarget(config.depth, engine);
            }
            updateContext.targetWidth = rt._width;
            updateContext.targetHeight = rt._height;
            refreshTaskSceneBindGroup(task, engine);
            buildBindings(task, engine, targetSignature);
            buildRenderPassDescriptor(task, rt);
        },
        execute(): number {
            return executePass(task, engine, targetSignature, updateContext);
        },
        dispose(): void {
            task._passes.length = 0;
            // disposeRenderTarget no-ops on the engine scRT and on eager
            // GeometryRendererTask depth outputs (both `_eager`), and on an undefined
            // rst/depth — so these can be passed unconditionally.
            disposeRenderTarget(config.rt);
            disposeRenderTarget(config.rst);
            disposeRenderTarget(config.depth);
            task._opaqueBindings.length = 0;
            task._directBindings.length = 0;
            task._transparentBindings.length = 0;
            task._renderables.length = 0;
            task._opaqueBundles.length = 0;
            task._sceneUBO.destroy();
        },
    };
    return task;
}

/** Remove a mesh from this task's renderable + binding lists. Idempotent. */
export function removeMeshFromTask(task: RenderTask, mesh: object): void {
    // Not a renderable-bearing task (e.g. a post/effect task that also carries `_config`): nothing to
    // remove. Guard keeps callers that scan all frame-graph tasks (removeFromScene) shape-safe.
    if (!task._renderables) {
        return;
    }
    let removed = false;
    for (let i = task._renderables.length - 1; i >= 0; i--) {
        if (task._renderables[i]!.mesh === mesh) {
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
        task._opaqueBundles.length = 0;
        task._lastVersion = -1;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

function resolvePendingMeshes(task: RenderTask, sc: SceneContext): void {
    if (task._pendingMeshes.length === 0) {
        return;
    }
    for (const { mesh, material } of task._pendingMeshes) {
        const rebuild = material._buildGroup?._rebuildSingle;
        if (!rebuild) {
            throw new Error();
        }
        const renderable = rebuild(sc, mesh, material);
        if (!task._renderables.includes(renderable)) {
            task._renderables.push(renderable);
        }
    }
    task._pendingMeshes.length = 0;
}

/** Per-frame back-to-front sort for transparent bindings using the active camera. */
function sortTransparentBindings(task: RenderTask, camera: Camera | null | undefined): void {
    const arr = task._transparentBindings;
    if (arr.length <= 1 || !camera) {
        return;
    }
    const v = getViewMatrix(camera);
    for (const b of arr) {
        const wc = b.renderable._worldCenter;
        b._sortDistance = wc ? wc[0]! * v[2]! + wc[1]! * v[6]! + wc[2]! * v[10]! + v[14]! : 0;
    }
    arr.sort((a, b) => b._sortDistance! - a._sortDistance! || a.renderable.order - b.renderable.order);
}

/** (Re)bucket task._renderables into bound lists. */
function buildBindings(task: RenderTask, eng: EngineContext, targetSignature: RenderTargetSignature): void {
    const opaque = task._opaqueBindings;
    const direct = task._directBindings;
    const transparent = task._transparentBindings;
    opaque.length = 0;
    direct.length = 0;
    transparent.length = 0;
    for (const r of task._renderables) {
        const binding = r.bind(eng, targetSignature);
        if (r.isTransparent || r._transmissive) {
            transparent.push(binding);
        } else if (r._direct) {
            direct.push(binding);
        } else {
            opaque.push(binding);
        }
    }
    opaque.sort((a, b) => a.renderable.order - b.renderable.order);
    direct.sort((a, b) => a.renderable.order - b.renderable.order);
    task._opaqueBundles.length = 0;
    task._lastVersion = (task.scene as SceneContext)._renderableVersion;
}

function buildRenderPassDescriptor(task: RenderTask, rt: RenderTarget): void {
    const att = task._colorAttachment;
    att.view = rt._colorView!;
    // End-of-pass MSAA resolve into a caller-supplied single-sample target.
    // record() only builds the target's color view for an MSAA rt, so its
    // presence is the gate. The swapchain case is wired per-frame in
    // executePass (its view changes each frame); this custom view is stable.
    att.resolveTarget = task._config.rst?._colorView ?? undefined;
    task._renderPassDescriptor.colorAttachments = rt._colorView ? [att] : [];

    const depthSrc = task._depthSrc ?? rt;
    const depthView = depthSrc._depthView;
    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (depthView) {
        const dd = depthSrc._descriptor;
        const loadOp = task._depthLoadOp ?? "clear";
        depthAttachment = {
            view: depthView,
            depthClearValue: dd._depthClearValue ?? 0,
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

function prepareRenderTaskPass(task: RenderTask, eng: EngineContext, targetSignature: RenderTargetSignature, context: DrawUpdateContext): void {
    const sc = task.scene as SceneContext;
    // Auto-resync when the source scene mutates.
    if (task._autoFromScene && task._lastVersion !== sc._renderableVersion) {
        task._renderables.length = 0;
        task._renderables.push(...sc._renderables);
        buildBindings(task, eng, targetSignature);
    }

    // Pre-pass work — runs before beginRenderPass. Updates the task-owned scene
    // UBO, scene-wide lights UBO, and per-binding UBOs. The scene bind group may
    // also need a refresh (lights buffer can be resized when glTF lights
    // extension raises MAX_LIGHTS after this task was first recorded).
    refreshTaskSceneBindGroup(task, eng);
    const camera = task._config.cam ?? sc.camera;
    sc._clusteredLightUpdater?.(camera, context.targetWidth, context.targetHeight);
    writePassSceneUBO(task, eng, sc, camera);
    refreshSceneLightsUBO(eng, sc);
    // Expose the active camera to per-binding `update()` calls. Some renderables
    // (e.g. transparent billboard systems) need it to compute view-space sort
    // depths during their update.
    (context as MutableDrawUpdateContext)._camera = camera;
    updateBindings(task._opaqueBindings, context);
    updateBindings(task._directBindings, context);
    updateBindings(task._transparentBindings, context);
    // Per-frame back-to-front sort for transparent bindings — must run AFTER
    // updateBindings so renderables that compute `_worldCenter` inside their
    // own `update()` (billboard systems) are seen with current values.
    sortTransparentBindings(task, camera);
}

function executePass(task: RenderTask, eng: EngineContext, targetSignature: RenderTargetSignature, context: DrawUpdateContext): number {
    const sc = task.scene;
    const sampleCount = targetSignature._sampleCount;
    prepareRenderTaskPass(task, eng, targetSignature, context);
    const att = task._colorAttachment;
    const cfg = task._config;
    if (cfg.rt._colorView) {
        // The engine scRT's color view is re-acquired every frame, so re-read
        // it here. Offscreen color views are stable between rebuilds — leaving att.view
        // untouched preserves an external override (swapchain-overlay shares the base
        // scene's MSAA color view). The resolve target (rst) is re-read each frame so an
        // `rst === scRT` picks up its fresh per-frame view.
        if (cfg.rt === eng.scRT) {
            att.view = cfg.rt._colorView;
        }
        att.resolveTarget = cfg.rst?._colorView ?? undefined;
        att.clearValue = task._autoFromScene ? sc.clearColor : cfg.clrColor!;
        att.loadOp = cfg.clr ? "clear" : "load";
    }
    if (task._executeWithTransmission) {
        return task._executeWithTransmission(sampleCount);
    }
    const pass = eng._currentEncoder.beginRenderPass(task._renderPassDescriptor);
    const draws = executePassBody(task, pass);
    pass.end();
    return draws;
}

/** Body of the registered `RenderPass`. Receives the live render-pass encoder
 *  and issues all draws (viewport/scissor, group(0) bind, opaque bundle replay,
 *  then direct-draws non-transparent direct + transparent). Returns the draw count. */
function executePassBody(task: RenderTask, pass: GPURenderPassEncoder): number {
    const eng = task.engine as EngineContext;
    const cfg = task._config;
    const rt = cfg.rt;
    const scene = task.scene as SceneContext;
    const opaqueBindings = task._opaqueBindings;
    const opaqueBundles = task._opaqueBundles;
    const sceneBG = task._sceneBG;

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

    // Opaque: cached render bundle. Invalidated by scene mutation (_renderableVersion)
    // or visibility version (_vis). The bundle records group(0) at its start so it can
    // be replayed standalone (executeBundles inherits no inherited state).
    if (task._lastVersion !== scene._renderableVersion || task._lastVis !== _vis || opaqueBundles.length === 0) {
        const desc = rt._descriptor;
        const be = eng._device.createRenderBundleEncoder({
            colorFormats: desc.format ? [desc.format] : [],
            // Use the task's target signature, not the RT descriptor: a depth
            // override (config.depth) supplies the depth format externally, so
            // the cached opaque pipelines are built with it while the colour RT
            // carries no depthStencilFormat of its own. The bundle encoder's
            // attachment state must match those pipelines exactly.
            depthStencilFormat: task._targetSignature._depthStencilFormat,
            sampleCount: desc.samples ?? 1,
        });
        be.setBindGroup(0, sceneBG);
        drawList(be, opaqueBindings, eng);
        opaqueBundles[0] = be.finish();
        task._lastVersion = scene._renderableVersion;
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

function refreshTaskSceneBindGroup(task: RenderTask, eng: EngineContext): void {
    const lightsUBO = ensureSceneLightState(eng, task.scene as SceneContext)._buffer;
    if (lightsUBO === task._lightsUBO) {
        return;
    }
    task._lightsUBO = lightsUBO;
    task._sceneBG = eng._device.createBindGroup({
        layout: getSceneBindGroupLayout(eng),
        entries: [
            { binding: 0, resource: { buffer: task._sceneUBO } },
            { binding: 1, resource: { buffer: lightsUBO } },
        ],
    });
    task._opaqueBundles.length = 0;
    task._lastVersion = -1;
}

/** Write the canonical SceneUniforms struct to the task-owned scene UBO.
 *  Bails before touching scratch/GPU when all inputs are unchanged. */
function writePassSceneUBO(task: RenderTask, eng: EngineContext, scene: SceneContext, camera: Camera | null): void {
    if (!camera) {
        return;
    }

    const v = camera.viewport;
    const rt = task._config.rt;
    const aspect = (task._config.cs ? eng.canvas.width / eng.canvas.height : rt._width / rt._height) * (v ? v.width / v.height : 1);
    const fog = scene.fog;
    const img = scene.imageProcessing;
    const envRotationY = scene.envRotationY || 0;
    const wv = camera.worldMatrixVersion;
    const s = task._su;
    if (s[0] === camera && s[1] === fog && s[2] === wv && s[3] === aspect && s[4] === envRotationY && s[5] === img.exposure && s[6] === img.contrast) {
        return;
    }
    s[0] = camera;
    s[1] = fog;
    s[2] = wv;
    s[3] = aspect;
    s[4] = envRotationY;
    s[5] = img.exposure;
    s[6] = img.contrast;

    const data = task._suData;
    _packSceneUniforms(data, eng, scene, camera, aspect);
    const contribs = scene._sceneUboContributors;
    if (contribs) {
        for (const c of contribs) {
            c(data, scene);
        }
    }
    eng._device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
}

function updateBindings(list: readonly DrawBinding[], context: DrawUpdateContext): void {
    for (const b of list) {
        b.update?.(context);
    }
}

/** Iterate DrawBindings, deduping setPipeline. */
function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly DrawBinding[], engine: EngineContext): number {
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
