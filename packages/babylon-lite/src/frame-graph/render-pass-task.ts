/**
 * RenderPassTask — a frame-graph task that begins a render pass into its
 * RenderTarget, draws renderables, and ends.
 *
 * Single execute path for both swapchain-resolved and offscreen targets:
 *   - `record()` builds the cached render-pass descriptor and the bucketed
 *     `DrawBinding` lists from `_renderables` (opaque / transmissive /
 *     transparent), then sorts opaque + transmissive by `order`.
 *   - `execute()` per-frame: patches the descriptor (swapchain view +
 *     loadOp + clearColor), updates per-binding UBOs, runs/uses the cached
 *     opaque render bundle, then direct-draws transmissive + transparent.
 *
 * Renderable population:
 *   - Explicit: push into `_renderables` directly, or `addToPass(mesh, opts)`
 *     which builds a (mesh, material) Renderable at `record()` time.
 *   - Auto scene mirror: when `_renderables` is empty at record() time, copy the
 *     scene's renderables. Re-sync happens automatically when the scene's
 *     `_renderableVersion` changes between frames (mesh add/remove, material swap).
 *
 * Swapchain mode is detected by `rt.descriptor.resolveToSwapchain`.
 * In that mode, the render target owns MSAA/depth textures as needed; the
 * swap view is acquired per-frame and patched into the descriptor as either
 * the resolve target or the direct color attachment. `clr: false` switches
 * color + depth `loadOp` to `"load"` so multiple scenes can share the
 * swapchain in one frame (e.g., a 3D scene + a UI overlay scene).
 */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import { _vis } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Camera } from "../camera/camera.js";
import type { Renderable, DrawBinding } from "../render/renderable.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene-core.js";
import type { Material, MaterialInternal } from "../material/material.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { getViewProjectionMatrix, getViewMatrix } from "../camera/camera.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import type { Task } from "./task.js";

export interface RenderPassTaskConfig {
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
}

export interface RenderPassTask extends Task {
    readonly name: string;
    /** Live task configuration. Mutating `clr` or `clrColor` affects subsequent frames. */
    readonly _config: RenderPassTaskConfig;
    _autoFromScene: boolean;

    /** Source-of-truth renderables. Bucketed binding lists below are derived from
     *  this list at `record()` (or re-sync when auto-filled and `_renderableVersion` changes). */
    _renderables: Renderable[];
    _opaqueBindings: DrawBinding[];
    _transmissiveBindings: DrawBinding[];
    _transparentBindings: DrawBinding[];

    /** Cached opaque render bundle. Invalidated by renderable list mutations
     *  (`_lastVersion`) and visibility changes (`_lastVis`). */
    _opaqueBundles: GPURenderBundle[];
    _lastVersion: number;
    _lastVis: number;

    /** Cached descriptor + color attachment (color view is patched per-frame in
     *  swapchain mode; clearColor is patched live every frame). */
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment | null;
    _depthAttachment: GPURenderPassDepthStencilAttachment | null;

    _targetSignature: RenderTargetSignature;
    _sampleCount: number;

    /** Per-task scene UBO + bind group. Created eagerly in createRenderPassTask
     *  so renderables can reference `_sceneBG` at `bind()` time. Written each
     *  frame by `writePassSceneUBO`. Destroyed in `dispose()`. */
    _sceneUBO: GPUBuffer;
    _sceneBG: GPUBindGroup;
    _suData: Float32Array;
    _su: unknown[];

    /** Add a mesh to this pass with an optional per-pass material override.
     *  Resolved at `record()` time via `material._buildGroup._rebuildSingle`,
     *  so the mesh's material family must already have been registered with
     *  the scene (so its batch builder has run). */
    addToPass(mesh: Mesh, opts?: { material?: Material }): void;
    _pendingMeshes: { mesh: Mesh; material: Material }[];
}

/** Create a render pass task. GPU resources (target textures + descriptor)
 *  are not allocated until `record()` runs (via `frameGraph.build()`).
 *
 *  Swapchain-targeted tasks acquire the swap view per-frame at execute time. */
export function createRenderPassTask(config: RenderPassTaskConfig, engine: EngineContext, scene: SceneContext): RenderPassTask {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    const rt = config.rt;
    config.clrColor ??= { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    const swapchain = rt.descriptor.resolveToSwapchain === true;
    const sampleCount = rt.descriptor.sampleCount ?? 1;
    // Offscreen RTTs need a Y-flipped projection so the result texture samples
    // upright when sourced by a downstream pass. Swapchain passes never flip.
    const flipY = !swapchain;
    const targetSignature: RenderTargetSignature = {
        colorFormat: rt.descriptor.colorFormat,
        depthStencilFormat: rt.descriptor.depthStencilFormat,
        sampleCount,
        flipY,
    };

    const sceneBGL = getSceneBindGroupLayout(eng);
    const sceneUBO = createEmptyUniformBuffer(eng, SCENE_UBO_BYTES, `${config.name}-scene-ubo`);
    const sceneBG = eng.device.createBindGroup({
        label: `${config.name}-scene-bg`,
        layout: sceneBGL,
        entries: [{ binding: 0, resource: { buffer: sceneUBO } }],
    });
    const task: RenderPassTask = {
        name: config.name,
        _config: config,
        engine: eng,
        scene: sc,
        _autoFromScene: false,
        _renderables: [],
        _opaqueBindings: [],
        _transmissiveBindings: [],
        _transparentBindings: [],
        _opaqueBundles: [],
        _lastVersion: -1,
        _lastVis: 0,
        _renderPassDescriptor: { colorAttachments: [] },
        _colorAttachment: null,
        _depthAttachment: null,
        _targetSignature: targetSignature,
        _sampleCount: sampleCount,
        _sceneUBO: sceneUBO,
        _sceneBG: sceneBG,
        _suData: new Float32Array(SCENE_UBO_BYTES / 4),
        _su: [null, null, NaN, NaN, NaN, NaN, NaN],
        _pendingMeshes: [],
        addToPass(mesh, opts) {
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
                mirrorSceneBuckets(task, sc);
            }
            buildRenderTarget(task._config.rt, eng);
            buildBindings(task, eng);
            buildRenderPassDescriptor(task, swapchain);
        },
        execute(): number {
            // Auto-resync when the source scene mutates.
            if (task._autoFromScene && task._lastVersion !== sc._renderableVersion) {
                task._renderables.length = 0;
                mirrorSceneBuckets(task, sc);
                buildBindings(task, eng);
            }
            // Per-frame back-to-front sort for transparent bindings.
            sortTransparentBindings(task);
            patchPerFrame(task, eng, swapchain);
            return executePass(task);
        },
        dispose(): void {
            disposeRenderTarget(task._config.rt);
            task._colorAttachment = null;
            task._depthAttachment = null;
            task._opaqueBindings.length = 0;
            task._transmissiveBindings.length = 0;
            task._transparentBindings.length = 0;
            task._renderables.length = 0;
            task._opaqueBundles.length = 0;
            task._sceneUBO.destroy();
        },
    };
    return task;
}

/** Remove a mesh from this task's renderable + binding lists. Idempotent. */
export function removeMeshFromTask(task: RenderPassTask, mesh: object): void {
    let removed = false;
    for (let i = task._renderables.length - 1; i >= 0; i--) {
        if (task._renderables[i]!.mesh === mesh) {
            task._renderables.splice(i, 1);
            removed = true;
        }
    }
    for (const arr of [task._opaqueBindings, task._transmissiveBindings, task._transparentBindings]) {
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

function resolvePendingMeshes(task: RenderPassTask, sc: SceneContextInternal): void {
    if (task._pendingMeshes.length === 0) {
        return;
    }
    for (const { mesh, material } of task._pendingMeshes) {
        const buildGroup = (material as MaterialInternal)._buildGroup;
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

function mirrorSceneBuckets(task: RenderPassTask, sc: SceneContextInternal): void {
    task._renderables.push(...sc._renderables);
}

/** Per-frame back-to-front sort for transparent bindings using the active camera. */
function sortTransparentBindings(task: RenderPassTask): void {
    const arr = task._transparentBindings;
    if (arr.length <= 1) {
        return;
    }
    const cam = task._config.cam ?? task.scene.camera;
    if (!cam) {
        return;
    }
    const w = cam.worldMatrix;
    const cx = w[12]!;
    const cy = w[13]!;
    const cz = w[14]!;
    for (const b of arr) {
        b._sortDistance = 0;
        const wc = b.renderable._worldCenter;
        if (wc) {
            const [wx, wy, wz] = wc;
            b._sortDistance = (wx - cx) ** 2 + (wy - cy) ** 2 + (wz - cz) ** 2;
        }
    }
    arr.sort((a, b) => b._sortDistance! - a._sortDistance! || a.renderable.order - b.renderable.order);
}

/** (Re)bucket task._renderables into bound lists. */
function buildBindings(task: RenderPassTask, eng: EngineContextInternal): void {
    task._opaqueBindings.length = 0;
    task._transmissiveBindings.length = 0;
    task._transparentBindings.length = 0;
    const sig = task._targetSignature;
    for (const r of task._renderables) {
        const binding = r.bind(eng, sig);
        if (r.isTransparent) {
            task._transparentBindings.push(binding);
        } else if (r.isTransmissive) {
            task._transmissiveBindings.push(binding);
        } else {
            task._opaqueBindings.push(binding);
        }
    }
    task._opaqueBindings.sort((a, b) => a.renderable.order - b.renderable.order);
    task._transmissiveBindings.sort((a, b) => a.renderable.order - b.renderable.order);
    task._opaqueBundles.length = 0;
    task._lastVersion = task.scene._renderableVersion;
}

/** Build the cached render-pass descriptor. Color + depth views come from the
 *  RenderTarget itself (swapchain RTs own their MSAA + depth textures); the swap
 *  view is patched in per-frame in `patchPerFrame`. */
function buildRenderPassDescriptor(task: RenderPassTask, swapchain: boolean): void {
    const rt = task._config.rt;
    const colorView = rt._colorView;
    const depthView = rt._depthView;

    let colorAttachment: GPURenderPassColorAttachment | null = null;
    if (colorView || swapchain) {
        colorAttachment = {
            view: colorView!,
            loadOp: "clear",
            storeOp: "store",
        };
    }

    const depthFormat = rt.descriptor.depthStencilFormat;
    const hasStencil = depthFormat ? depthFormat === "depth24plus-stencil8" || depthFormat === "depth32float-stencil8" || depthFormat === "stencil8" : false;
    let depthAttachment: GPURenderPassDepthStencilAttachment | null = null;
    if (depthView) {
        depthAttachment = {
            view: depthView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
            ...(hasStencil ? { stencilClearValue: 0, stencilLoadOp: "clear" as const, stencilStoreOp: "store" as const } : {}),
        };
    }

    task._colorAttachment = colorAttachment;
    task._depthAttachment = depthAttachment;
    task._renderPassDescriptor = {
        label: task.name,
        colorAttachments: colorAttachment ? [colorAttachment] : [],
        depthStencilAttachment: depthAttachment ?? undefined,
    };
}

/** Patch the cached descriptor with per-frame state. For swapchain mode, the swap
 *  view is acquired per-frame; with MSAA it is the resolveTarget (the RT's MSAA
 *  texture is the color attachment), without MSAA it is the color attachment view. */
function patchPerFrame(task: RenderPassTask, eng: EngineContextInternal, swapchain: boolean): void {
    const att = task._colorAttachment;
    const c = task._config;
    if (att) {
        // Read the live scene clearColor for auto-filled tasks: scenes commonly do
        // `scene.clearColor = {...}` (assignment, not mutation), so the original
        // reference captured at task-creation goes stale.
        att.clearValue = task._autoFromScene ? task.scene.clearColor : c.clrColor!;
        att.loadOp = c.clr !== false ? "clear" : "load";
        if (swapchain) {
            const swapView = eng._swapchainView;
            if (task._sampleCount > 1) {
                att.resolveTarget = swapView;
            } else {
                att.view = swapView;
            }
        }
    }
}

function executePass(task: RenderPassTask): number {
    const eng = task.engine as EngineContextInternal;
    const encoder = eng._currentEncoder;
    const rt = task._config.rt;
    const scene = task.scene;
    const camera = task._config.cam ?? scene.camera;

    // Per-pass scene UBO write — uses task config camera if set, else scene.camera.
    writePassSceneUBO(task, eng, scene, camera);

    updateBindingUBOs(task._opaqueBindings);
    updateBindingUBOs(task._transmissiveBindings);
    updateBindingUBOs(task._transparentBindings);

    const pass = encoder.beginRenderPass(task._renderPassDescriptor);
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
    pass.setBindGroup(0, task._sceneBG);

    // Opaque: cached render bundle. Invalidated by scene mutation (_renderableVersion)
    // or visibility version (_vis). The bundle records group(0) at its start so it can
    // be replayed standalone (executeBundles inherits no inherited state).
    if (task._lastVersion !== scene._renderableVersion || task._lastVis !== _vis || task._opaqueBundles.length === 0) {
        const be = eng.device.createRenderBundleEncoder({
            label: `${task.name}-opaque`,
            colorFormats: [rt.descriptor.colorFormat],
            depthStencilFormat: rt.descriptor.depthStencilFormat,
            sampleCount: rt.descriptor.sampleCount ?? 1,
        });
        be.setBindGroup(0, task._sceneBG);
        drawList(be, task._opaqueBindings, eng);
        task._opaqueBundles[0] = be.finish();
        task._lastVersion = scene._renderableVersion;
        task._lastVis = _vis;
    }
    let draws = task._opaqueBindings.length;
    pass.executeBundles(task._opaqueBundles);
    // executeBundles invalidates pass bind-group state — rebind group 0 before further draws.
    pass.setBindGroup(0, task._sceneBG);
    draws += drawList(pass, task._transmissiveBindings, eng);
    draws += drawList(pass, task._transparentBindings, eng);
    pass.end();
    return draws;
}

/** Write the canonical SceneUniforms struct to the task-owned scene UBO.
 *  Bails before touching scratch/GPU when all inputs are unchanged. */
function writePassSceneUBO(task: RenderPassTask, eng: EngineContextInternal, scene: SceneContextInternal, camera: Camera | null): void {
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
    //   vFogColor       = 84
    data.set(viewProj, 0);
    // Y-flip for offscreen passes — negate row 1 of the projection (the multiplied
    // view*proj matrix). Row 1 of a column-major mat4 lives at indices 1,5,9,13.
    if (task._targetSignature.flipY) {
        data[1] = -data[1]!;
        data[5] = -data[5]!;
        data[9] = -data[9]!;
        data[13] = -data[13]!;
    }
    data.set(viewMat, 16);
    data[32] = wm[12]!;
    data[33] = wm[13]!;
    data[34] = wm[14]!;

    if (fog) {
        data[80] = fog.mode;
        data[81] = fog.start;
        data[82] = fog.end;
        data[83] = fog.density;
        data[84] = fog.color[0]!;
        data[85] = fog.color[1]!;
        data[86] = fog.color[2]!;
    }

    data[36] = envRotationY;
    if (envTextures?.sphericalHarmonics) {
        data.set(envTextures.sphericalHarmonics, 40);
    }

    data[76] = img.exposure;
    data[77] = img.contrast;
    data[78] = envTextures?.lodGenerationScale ?? 0.8;

    eng.device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
}

function updateBindingUBOs(list: readonly DrawBinding[]): void {
    for (const b of list) {
        if (b.updateUBOs) {
            b.updateUBOs();
        }
    }
}

/** Iterate DrawBindings, deduping setPipeline. */
function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly DrawBinding[], engine: EngineContextInternal): number {
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
