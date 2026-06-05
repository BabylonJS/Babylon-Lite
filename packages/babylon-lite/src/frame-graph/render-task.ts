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
 * Swapchain mode is detected by `rt.descriptor.resolveToSwapchain` and is
 * handled inside the `RenderPass` (the swap view is patched into the cached
 * descriptor per frame, as either the resolveTarget for MSAA RTs or the
 * direct color view otherwise). `clr: false` switches color + depth `loadOp`
 * to `"load"` so multiple scenes can share the swapchain in one frame
 * (e.g., a 3D scene + a UI overlay scene).
 */

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
import { getViewProjectionMatrix, getViewMatrix } from "../camera/camera.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
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
    /** Background clear color. May be mutated frame-to-frame. */
    clrColor?: GPUColorDict;
    /** When true, controls color + depth `loadOp` ("clear"). When false, use "load"
     *  so this pass overlays previous content (UI overlays, second scene, etc.). */
    clr?: boolean;
    /** Per-pass camera override. Null/undefined uses `scene.camera`. */
    cam?: Camera | null;
    /** Use canvas dimensions, not render-target dimensions, for this pass's scene UBO aspect. */
    cs?: boolean;
    /** Scene-texture transmission settings. `copyCount: 0` copies before every transmissive draw.
     *  `generateMipmaps: false` allocates only mip 0 for the refraction texture and skips mip generation. */
    transmission?: { copyCount?: number; generateMipmaps?: boolean };
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
    const rt = config.rt;
    config.clrColor ??= { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    config.clr ??= true;
    const desc = rt._descriptor;
    // Offscreen RTTs usually need a Y-flipped projection so the result texture
    // samples upright when sourced by a downstream pass. Depth-only shadow maps
    // can override this to preserve shadow-sampler UV conventions.
    const targetSignature = {
        _colorFormat: desc.colorFormat,
        _depthStencilFormat: desc.depthStencilFormat,
        _depthCompare: desc._depthCompare,
        _sampleCount: desc.sampleCount ?? 1,
        _flipY: desc.flipY ?? desc.resolveToSwapchain !== true,
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
        _sceneUBO: sceneUBO,
        _sceneBG: sceneBG,
        _lightsUBO: lightsUBO,
        _suData: new Float32Array(SCENE_UBO_BYTES / 4),
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
            buildRenderTarget(rt, engine);
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
            disposeRenderTarget(rt);
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
        const buildGroup = material._buildGroup;
        const rebuild = buildGroup?._rebuildSingle;
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
    task._colorAttachment.view = rt._colorView!;
    task._renderPassDescriptor.colorAttachments = rt._colorView ? [task._colorAttachment] : [];

    const depthView = rt._depthView;
    let depthAttachment: GPURenderPassDepthStencilAttachment | null = null;
    if (depthView) {
        depthAttachment = {
            view: depthView,
            depthClearValue: rt._descriptor._depthClearValue ?? 0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
        };
        if (rt._descriptor.depthStencilFormat?.includes("stencil")) {
            depthAttachment.stencilClearValue = 0;
            depthAttachment.stencilLoadOp = "clear";
            depthAttachment.stencilStoreOp = "store";
        }
    }

    task._renderPassDescriptor.depthStencilAttachment = depthAttachment ?? undefined;
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
    writePassSceneUBO(task, eng, sc, camera, targetSignature._flipY);
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
    const swapchain = cfg.rt._descriptor.resolveToSwapchain === true;
    if (cfg.rt._colorView || swapchain) {
        att.clearValue = task._autoFromScene ? sc.clearColor : cfg.clrColor!;
        att.loadOp = cfg.clr ? "clear" : "load";
    }
    if (swapchain) {
        const swapView = eng._swapchainView;
        if (sampleCount > 1) {
            att.resolveTarget = swapView;
        } else {
            att.view = swapView;
        }
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
            colorFormats: desc.colorFormat ? [desc.colorFormat] : [],
            depthStencilFormat: desc.depthStencilFormat,
            sampleCount: desc.sampleCount ?? 1,
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
function writePassSceneUBO(task: RenderTask, eng: EngineContext, scene: SceneContext, camera: Camera | null, flipY?: boolean): void {
    if (!camera) {
        return;
    }

    const v = camera.viewport;
    const rt = task._config.rt;
    const aspect = (task._config.cs ? eng.canvas.width / eng.canvas.height : rt._width / rt._height) * (v ? v.width / v.height : 1);
    const fog = scene.fog;
    const envTextures = scene._envTextures;
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
    data.fill(0);

    const viewProj = getViewProjectionMatrix(camera, aspect);
    const viewMat = getViewMatrix(camera);
    const wm = camera.worldMatrix;

    // SCENE_UBO float offsets (see shaders/scene-uniforms.wgsl):
    //   viewProjection  = 0    view             = 16   vEyePosition    = 32
    //   envRotationY    = 36   vSphericalL00    = 40   exposureLinear  = 76
    //   contrast        = 77   lodGenerationScale = 78 vFogInfos       = 80
    //   vFogColor       = 84   clipPlane        = 88
    packMat4IntoF32(data, viewProj, 0);
    // Y-flip for offscreen passes — negate row 1 of the projection (the multiplied
    // view*proj matrix). Row 1 of a column-major mat4 lives at indices 1,5,9,13.
    if (flipY) {
        data[1] = -data[1]!;
        data[5] = -data[5]!;
        data[9] = -data[9]!;
        data[13] = -data[13]!;
    }
    packMat4IntoF32(data, viewMat, 16);
    // vEyePosition uniform — the world-space camera position. For LWR-on
    // scenes the camera is at the origin in the eye-relative frame (the
    // mesh-world pack and the view matrix translation both already encode
    // the offset subtraction), so the uniform is mathematically zero.
    // For non-LWR scenes it's the camera world translation. Shader code
    // that does `vEyePosition - input.worldPos` produces the eye-relative
    // vector at full precision in both cases.
    if (eng.useFloatingOrigin) {
        data[32] = 0;
        data[33] = 0;
        data[34] = 0;
    } else {
        data[32] = wm[12]!;
        data[33] = wm[13]!;
        data[34] = wm[14]!;
    }

    data[87] = eng.canvas.width;

    data[36] = envRotationY;

    data[76] = img.exposure;
    data[77] = img.contrast;
    data[78] = envTextures?.lodGenerationScale ?? 0.8;
    data[79] = +img.toneMappingEnabled;
    data[37] = eng.canvas.height;
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
