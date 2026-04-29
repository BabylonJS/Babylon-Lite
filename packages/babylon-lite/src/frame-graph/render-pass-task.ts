/**
 * RenderPassTask — a frame-graph task that begins a render pass into its
 * RenderTarget, draws renderables, and ends.
 *
 * Single execute path for both swapchain-resolved and offscreen targets:
 *   - `record()` builds the cached render-pass descriptor and the bucketed
 *     `DrawBinding` lists from `_renderables` (opaque / transmissive /
 *     transparent), then sorts opaque + transmissive by `order`.
 *   - `execute(encoder)` per-frame: patches the descriptor (swapchain view +
 *     loadOp + clearColor), updates per-binding UBOs, runs/uses the cached
 *     opaque render bundle, then direct-draws transmissive + transparent.
 *
 * Renderable population:
 *   - Explicit: push into `_renderables` directly, or `addToPass(mesh, opts)`
 *     which builds a (mesh, material) Renderable at `record()` time.
 *   - `autoFromScene: true`: when `_renderables` is empty at record() time,
 *     copy the scene's `_opaque/_transmissive/_transparentRenderables` arrays.
 *     Re-sync happens automatically when the scene's `_renderableVersion`
 *     changes between frames (mesh add/remove, material swap).
 *
 * Swapchain mode is detected by `renderTarget.descriptor.resolveToSwapchain`.
 * In that mode, the render target itself allocates nothing — color uses the
 * engine's shared MSAA texture (or the swap view directly when MSAA is off)
 * and depth uses the engine's shared depth texture. The swap view is acquired
 * per-frame and patched into the descriptor at execute time. `clear: false`
 * switches color + depth `loadOp` to `"load"` so multiple scenes can share
 * the swapchain in one frame (e.g., a 3D scene + a UI overlay scene).
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
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms.js";
import { writePassSceneUBO } from "../scene/scene-ubo.js";
import type { Task } from "./task.js";

export interface RenderPassTaskConfig {
    name: string;
    renderTarget: RenderTarget;
    /** Background clear color. May be mutated frame-to-frame. */
    clearColor?: GPUColorDict;
    /** When true, controls color + depth `loadOp` ("clear"). When false, use "load"
     *  so this pass overlays previous content (UI overlays, second scene, etc.). */
    clear?: boolean;
    /** When true and `_renderables` is empty at record() time, the task mirrors the
     *  scene's three renderable buckets. Re-sync triggers automatically on
     *  `scene._renderableVersion` change. Default false. */
    autoFromScene?: boolean;
}

export interface RenderPassTask extends Task {
    readonly name: string;
    readonly renderTarget: RenderTarget;
    /** Mutable. */
    clearColor: GPUColorDict;
    /** Mutable. */
    clear: boolean;
    /** See `RenderPassTaskConfig.autoFromScene`. */
    autoFromScene: boolean;
    /** Per-pass camera override. When null (default), uses `scene.camera`.
     *  Set this on a task to render the scene from a different POV (e.g. an
     *  RTT pass with a mirror/light/cube-face camera). */
    camera: Camera | null;

    /** Source-of-truth renderables. Bucketed binding lists below are derived from
     *  this list at `record()` (or re-sync when `autoFromScene && _renderableVersion` changes). */
    _renderables: Renderable[];
    _opaqueBindings: DrawBinding[];
    _transmissiveBindings: DrawBinding[];
    _transparentBindings: DrawBinding[];

    /** Cached opaque render bundle. Invalidated by renderable list mutations
     *  (`_lastVersion`) and visibility changes (`_lastVis`). */
    _opaqueBundle: GPURenderBundle | null;
    _lastVersion: number;
    _lastVis: number;

    /** Cached descriptor + color attachment (color view is patched per-frame in
     *  swapchain mode; clearColor is patched live every frame). */
    _renderPassDescriptor: GPURenderPassDescriptor | null;
    _colorAttachment: GPURenderPassColorAttachment | null;
    _depthAttachment: GPURenderPassDepthStencilAttachment | null;

    _targetSignature: RenderTargetSignature;

    /** Per-task scene UBO + bind group. Created eagerly in createRenderPassTask
     *  so renderables can reference `_sceneBG` at `bind()` time. Written each
     *  frame by `writePassSceneUBO`. Destroyed in `dispose()`. */
    _sceneUBO: GPUBuffer;
    _sceneBG: GPUBindGroup;

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
 *  Swapchain-targeted tasks use the engine's shared MSAA + depth textures
 *  and acquire the swap view per-frame at execute time. */
export function createRenderPassTask(config: RenderPassTaskConfig, engine: EngineContext, scene: SceneContext): RenderPassTask {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    const rt = config.renderTarget;
    const swapchain = rt.descriptor.resolveToSwapchain === true;
    // Offscreen RTTs need a Y-flipped projection so the result texture samples
    // upright when sourced by a downstream pass. Swapchain passes never flip.
    const flipY = !swapchain;
    const targetSignature: RenderTargetSignature = {
        colorFormat: rt.descriptor.colorFormat,
        depthStencilFormat: rt.descriptor.depthStencilFormat,
        sampleCount: rt.descriptor.sampleCount ?? 1,
        flipY,
    };

    const sceneBGL = getSceneBindGroupLayout(eng);
    const sceneUBO = createEmptyUniformBuffer(eng, SCENE_UBO_BYTES);
    const sceneBG = eng.device.createBindGroup({
        label: `scene-bg:${config.name}`,
        layout: sceneBGL,
        entries: [{ binding: 0, resource: { buffer: sceneUBO } }],
    });

    const task: RenderPassTask = {
        name: config.name,
        engine: eng,
        scene: sc,
        renderTarget: rt,
        clearColor: config.clearColor ?? { r: 0.2, g: 0.2, b: 0.3, a: 1.0 },
        clear: config.clear !== false,
        autoFromScene: config.autoFromScene ?? false,
        camera: null,
        _renderables: [],
        _opaqueBindings: [],
        _transmissiveBindings: [],
        _transparentBindings: [],
        _opaqueBundle: null,
        _lastVersion: -1,
        _lastVis: 0,
        _renderPassDescriptor: null,
        _colorAttachment: null,
        _depthAttachment: null,
        _targetSignature: targetSignature,
        _sceneUBO: sceneUBO,
        _sceneBG: sceneBG,
        _pendingMeshes: [],
        addToPass(mesh, opts) {
            const material = opts?.material ?? mesh.material;
            if (!material) {
                return;
            }
            task._pendingMeshes.push({ mesh, material });
        },
        record(): void {
            resolvePendingMeshes(task, sc);
            if (task.autoFromScene && task._renderables.length === 0) {
                mirrorSceneBuckets(task, sc);
            }
            buildRenderTarget(task.renderTarget, eng);
            buildBindings(task, eng);
            buildRenderPassDescriptor(task, swapchain);
        },
        execute(): number {
            // Auto-resync when the source scene mutates.
            if (task.autoFromScene && task._lastVersion !== sc._renderableVersion) {
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
            disposeRenderTarget(task.renderTarget);
            task._renderPassDescriptor = null;
            task._colorAttachment = null;
            task._depthAttachment = null;
            task._opaqueBindings.length = 0;
            task._transmissiveBindings.length = 0;
            task._transparentBindings.length = 0;
            task._renderables.length = 0;
            task._opaqueBundle = null;
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
        task._opaqueBundle = null;
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
            throw new Error(`RenderPassTask.addToPass: material has no _rebuildSingle wired — register at least one mesh of this material family via addToScene first.`);
        }
        const renderable = rebuild(sc, mesh, material);
        if (!task._renderables.includes(renderable)) {
            task._renderables.push(renderable);
        }
    }
    task._pendingMeshes.length = 0;
}

function mirrorSceneBuckets(task: RenderPassTask, sc: SceneContextInternal): void {
    for (const r of sc._renderables) {
        task._renderables.push(r);
    }
}

/** Per-frame back-to-front sort for transparent bindings using the active camera. */
function sortTransparentBindings(task: RenderPassTask): void {
    const arr = task._transparentBindings;
    if (arr.length <= 1) {
        return;
    }
    const cam = task.camera ?? task.scene.camera;
    if (!cam) {
        return;
    }
    const w = cam.worldMatrix;
    const cx = w[12]!;
    const cy = w[13]!;
    const cz = w[14]!;
    for (const b of arr) {
        const wc = b.renderable._worldCenter;
        if (wc) {
            const [wx, wy, wz] = wc;
            b._sortDistance = (wx - cx) ** 2 + (wy - cy) ** 2 + (wz - cz) ** 2;
        }
    }
    arr.sort((a, b) => (b._sortDistance ?? 0) - (a._sortDistance ?? 0) || a.renderable.order - b.renderable.order);
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
    task._opaqueBundle = null;
    task._lastVersion = task.scene._renderableVersion;
}

/** Build the cached render-pass descriptor. Color + depth views come from the
 *  RenderTarget itself (swapchain RTs own their MSAA + depth textures); the swap
 *  view is patched in per-frame in `patchPerFrame`. */
function buildRenderPassDescriptor(task: RenderPassTask, swapchain: boolean): void {
    const rt = task.renderTarget;
    const colorView = rt._colorView;
    const depthView = rt._depthView;

    let colorAttachment: GPURenderPassColorAttachment | null = null;
    if (colorView || swapchain) {
        colorAttachment = {
            view: colorView!,
            clearValue: task.clearColor,
            loadOp: task.clear ? "clear" : "load",
            storeOp: "store",
        };
    }

    const depthFormat = rt.descriptor.depthStencilFormat;
    const hasStencil = depthFormat ? depthFormat === "depth24plus-stencil8" || depthFormat === "depth32float-stencil8" || depthFormat === "stencil8" : false;
    let depthAttachment: GPURenderPassDepthStencilAttachment | null = null;
    if (depthView) {
        const loadOp: GPULoadOp = task.clear ? "clear" : "load";
        depthAttachment = {
            view: depthView,
            depthClearValue: 1.0,
            depthLoadOp: loadOp,
            depthStoreOp: "store",
            ...(hasStencil ? { stencilClearValue: 0, stencilLoadOp: loadOp, stencilStoreOp: "store" as const } : {}),
        };
    }

    task._colorAttachment = colorAttachment;
    task._depthAttachment = depthAttachment;
    task._renderPassDescriptor = {
        colorAttachments: colorAttachment ? [colorAttachment] : [],
        depthStencilAttachment: depthAttachment ?? undefined,
    };
}

/** Patch the cached descriptor with per-frame state. For swapchain mode, the swap
 *  view is acquired per-frame; with MSAA it is the resolveTarget (the RT's MSAA
 *  texture is the color attachment), without MSAA it is the color attachment view. */
function patchPerFrame(task: RenderPassTask, eng: EngineContextInternal, swapchain: boolean): void {
    const att = task._colorAttachment;
    if (att) {
        // Read the live scene clearColor for autoFromScene tasks: scenes commonly do
        // `scene.clearColor = {...}` (assignment, not mutation), so the original
        // reference captured at task-creation goes stale.
        att.clearValue = task.autoFromScene ? task.scene.clearColor : task.clearColor;
        att.loadOp = task.clear ? "clear" : "load";
        if (swapchain) {
            const swapView = eng._swapchainView;
            const msaaView = task.renderTarget._colorView;
            if (msaaView) {
                att.view = msaaView;
                if (swapView) {
                    att.resolveTarget = swapView;
                }
            } else if (swapView) {
                att.view = swapView;
            }
        }
    }
    const dsa = task._depthAttachment;
    if (dsa) {
        const loadOp: GPULoadOp = task.clear ? "clear" : "load";
        dsa.depthLoadOp = loadOp;
        if (dsa.stencilLoadOp !== undefined) {
            dsa.stencilLoadOp = loadOp;
        }
    }
}

function executePass(task: RenderPassTask): number {
    if (!task._renderPassDescriptor) {
        return 0;
    }
    const eng = task.engine as EngineContextInternal;
    const encoder = eng._currentEncoder;
    if (!encoder) {
        return 0;
    }
    const rt = task.renderTarget;

    // Per-pass scene UBO write — uses task.camera if set, else scene.camera.
    writePassSceneUBO(task, eng, task.scene, task.camera ?? task.scene.camera);

    for (const b of task._opaqueBindings) {
        if (b.updateUBOs) {
            b.updateUBOs();
        }
    }
    for (const b of task._transmissiveBindings) {
        if (b.updateUBOs) {
            b.updateUBOs();
        }
    }
    for (const b of task._transparentBindings) {
        if (b.updateUBOs) {
            b.updateUBOs();
        }
    }

    const pass = encoder.beginRenderPass(task._renderPassDescriptor);
    // Viewport always follows the RT's own size (re-allocated on canvas resize for
    // canvas-sized RTs).
    pass.setViewport(0, 0, rt._width, rt._height, 0, 1);
    // Scene bind group (group 0) is task-owned and identical for every draw in this pass.
    pass.setBindGroup(0, task._sceneBG);

    // Opaque: cached render bundle. Invalidated by scene mutation (_renderableVersion)
    // or visibility version (_vis). The bundle records group(0) at its start so it can
    // be replayed standalone (executeBundles inherits no inherited state).
    if (task._lastVersion !== task.scene._renderableVersion || task._lastVis !== _vis || !task._opaqueBundle) {
        const be = eng.device.createRenderBundleEncoder({
            colorFormats: [rt.descriptor.colorFormat],
            depthStencilFormat: rt.descriptor.depthStencilFormat,
            sampleCount: rt.descriptor.sampleCount ?? 1,
        });
        be.setBindGroup(0, task._sceneBG);
        drawList(be, task._opaqueBindings, eng);
        task._opaqueBundle = be.finish();
        task._lastVersion = task.scene._renderableVersion;
        task._lastVis = _vis;
    }
    let draws = task._opaqueBindings.length;
    pass.executeBundles([task._opaqueBundle]);
    // executeBundles invalidates pass bind-group state — rebind group 0 before further draws.
    pass.setBindGroup(0, task._sceneBG);
    draws += drawList(pass, task._transmissiveBindings, eng);
    draws += drawList(pass, task._transparentBindings, eng);
    pass.end();
    return draws;
}

/** Iterate DrawBindings, deduping setPipeline.
 *  Bindings with no `pipeline` (set internally by `draw()`) reset the dedup state. */
function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly DrawBinding[], engine: EngineContextInternal): number {
    let lp: GPURenderPipeline | null = null;
    let draws = 0;
    for (const b of list) {
        const mesh = b.renderable.mesh;
        if (mesh && mesh.visible === false) {
            continue;
        }
        if (b.pipeline && b.pipeline !== lp) {
            enc.setPipeline(b.pipeline);
            lp = b.pipeline;
        }
        draws += b.draw(enc, engine);
        if (!b.pipeline) {
            lp = null;
        }
    }
    return draws;
}
