/**
 * RenderPassTask — a frame graph task that executes a WebGPU render pass.
 *
 * Each RenderPassTask owns:
 *   - A RenderTarget (defines the output textures / format / MSAA)
 *   - Renderable arrays (built for that target's format + sampleCount)
 *   - Scene uniform updaters
 *   - An opaque render bundle cache
 *
 * The task encapsulates: beginRenderPass → draw → end.
 */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { DrawBinding, Renderable, RenderTargetSignature } from "../render/renderable.js";
import type { Mesh } from "../mesh/mesh.js";
import type { RenderTarget } from "../engine/render-target.js";
import { targetSignatureKey, buildRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import type { Camera } from "../camera/camera.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene.js";
import { getOrBuildMeshRenderable } from "../scene/scene-core.js";
import { writePassSceneUBO, destroyTaskSceneState } from "../scene/scene-ubo.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-fields.js";
import type { Task } from "./task.js";

/** Configuration for creating a render pass task. */
export interface RenderPassTaskConfig {
    name: string;
    renderTarget: RenderTarget;
    clearColor?: GPUColorDict;
    /** When true, at `record()` time, if the task's `_renderables` list is empty, copy
     *  `scene._renderables` into it. This makes the main pass automatically render the
     *  whole scene without per-pass authoring. Default false (explicit-content pass). */
    autoFromScene?: boolean;
}

/** A frame graph task that renders into a render target. */
export interface RenderPassTask extends Task {
    readonly name: string;
    readonly renderTarget: RenderTarget;
    clearColor: GPUColorDict;
    /** See `RenderPassTaskConfig.autoFromScene`. The flag is NEVER auto-toggled — if the user
     *  later clears `_renderables`, the next `record()` will re-mirror from the scene. */
    autoFromScene: boolean;

    /** Raw, target-independent renderables accumulated explicitly via per-pass APIs.
     *  Source of truth — bucketed/bound lists below are derived from this list at record time.
     *  When `autoFromScene` is true and this list is empty at `record()` time, it is populated
     *  from `scene._renderables`. */
    _renderables: Renderable[];

    /** Opaque draw bindings — sorted by order at build time. */
    _opaqueBindings: DrawBinding[];
    /** Transmissive draw bindings — opaque but need opaque-scene RTT as input. */
    _transmissiveBindings: DrawBinding[];
    /** Transparent draw bindings — sorted per-frame by camera distance. */
    _transparentBindings: DrawBinding[];
    /** All draw bindings (union) — for UBO updates. */
    _allBindings: DrawBinding[];

    // ─── Bundle cache ─────────────────────────────────────────
    _opaqueBundle: GPURenderBundle | null;
    _bundleVersion: number;
    /** Version of the renderable list — compared to detect changes. */
    _renderableVersion: number;
    /** Target signature key at last populate — bundle must rebuild when it changes. */
    _boundTargetKey: string;

    // ─── Pass-owned scene state (created eagerly in createRenderPassTask) ───────
    /** Unified scene UBO (group 0, binding 0). */
    _sceneUBO: GPUBuffer;
    /** Bind group referencing _sceneUBO. Bound once per pass + once per bundle recording. */
    _sceneBG: GPUBindGroup;

    // ─── Cached render pass descriptor (built in record(), reused each frame) ─────
    _renderPassDescriptor: GPURenderPassDescriptor | null;
    _colorAttachment: GPURenderPassColorAttachment | null;

    /** Optional camera override — when null, uses scene.camera. */
    camera: Camera | null;

    /** Add a mesh to this pass with an optional per-pass material override.
     *  When `opts.material` is provided, that material is used instead of
     *  `mesh.material` (a separate Renderable is built). The same `(mesh, material)`
     *  pair is shared across passes that add it.
     *
     *  Build is deferred until `record()` so this can be called at scene authoring
     *  time before the material's batch builder has wired `_rebuildSingle`. */
    addToPass(mesh: Mesh, opts?: { material?: unknown }): void;

    /** Pending mesh additions resolved into Renderables at `record()` time. */
    _pendingMeshes: { mesh: Mesh; material: unknown }[];
}

/** Create a render pass task. The pass's scene UBO + bind group are allocated up-front
 *  so renderables can reference them immediately and the cached opaque bundle never
 *  needs to be invalidated by scene-state changes. */
export function createRenderPassTask(config: RenderPassTaskConfig, engine: EngineContext, scene: SceneContext): RenderPassTask {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    const sceneUBO = createEmptyUniformBuffer(eng, SCENE_UBO_BYTES);
    const sceneBG = eng.device.createBindGroup({
        label: `task-scene-bg:${config.name}`,
        layout: getSceneBindGroupLayout(eng),
        entries: [{ binding: 0, resource: { buffer: sceneUBO } }],
    });
    const task: RenderPassTask = {
        name: config.name,
        engine: eng,
        scene: sc,
        renderTarget: config.renderTarget,
        clearColor: config.clearColor ?? { r: 0.2, g: 0.2, b: 0.3, a: 1.0 },
        autoFromScene: config.autoFromScene ?? false,
        _renderables: [],
        _opaqueBindings: [],
        _transmissiveBindings: [],
        _transparentBindings: [],
        _allBindings: [],
        _opaqueBundle: null,
        _bundleVersion: -1,
        _renderableVersion: 0,
        _boundTargetKey: "",
        _sceneUBO: sceneUBO,
        _sceneBG: sceneBG,
        _renderPassDescriptor: null,
        _colorAttachment: null,
        camera: null,
        _pendingMeshes: [],
        addToPass(mesh, opts) {
            const material = opts?.material ?? mesh.material;
            if (!material) {
                return;
            }
            task._pendingMeshes.push({ mesh, material });
        },
        record: () => {
            // Resolve pending mesh additions — `_rebuildSingle` is wired by the material's
            // batch builder, which runs in `drainSceneBuilders` BEFORE the frame graph build,
            // so it is guaranteed to be available here.
            for (const { mesh, material } of task._pendingMeshes) {
                const buildGroup = (material as any)._buildGroup;
                const rebuild = buildGroup?._rebuildSingle as undefined | ((s: SceneContext, m: Mesh, mat: unknown) => Renderable);
                if (!rebuild) {
                    throw new Error("RenderPassTask.addToPass: material has no _rebuildSingle wired — register at least one mesh of this material family via addToScene first.");
                }
                const renderable = getOrBuildMeshRenderable(sc, mesh, material, rebuild);
                if (!task._renderables.includes(renderable)) {
                    task._renderables.push(renderable);
                }
            }
            task._pendingMeshes.length = 0;
            if (task.autoFromScene && task._renderables.length === 0) {
                task._renderables.push(...sc._renderables);
            }
            buildRenderTarget(task.renderTarget, eng);
            buildTaskBindings(task, eng);
            buildRenderPassDescriptor(task);
        },
        execute: (encoder) => {
            sortTransparents(task, task.camera ?? task.scene.camera ?? null);
            return executeRenderPassTask(task, encoder);
        },
        dispose: () => {
            destroyTaskSceneState(task);
            disposeRenderTarget(task.renderTarget);
        },
    };
    return task;
}

/**
 * Build (or rebuild) the bucketed/bound binding lists from `task._renderables`.
 * Each raw renderable is bound to the task's render target signature so that
 * pipelines are resolved against this task's color/depth format and sample count.
 */
export function buildTaskBindings(task: RenderPassTask, engine: EngineContextInternal): void {
    task._opaqueBindings.length = 0;
    task._transmissiveBindings.length = 0;
    task._transparentBindings.length = 0;
    task._allBindings.length = 0;

    const desc = task.renderTarget.descriptor;
    // flipY: offscreen RTTs render with a Y-flipped projection (BJS quirk — see writePassSceneUBO).
    // Threaded through the render-target signature so pipelines invert frontFace and back-face culling
    // stays correct.
    const target: RenderTargetSignature = {
        colorFormat: desc.colorFormat,
        depthStencilFormat: desc.depthStencilFormat,
        sampleCount: desc.sampleCount,
        flipY: !desc.resolveToSwapchain,
    };
    task._boundTargetKey = targetSignatureKey(target);
    task._opaqueBundle = null;
    task._bundleVersion = -1;

    for (const r of task._renderables) {
        const binding = r.bind(engine, target);
        const bucket = r.isTransparent ? task._transparentBindings : r.isTransmissive ? task._transmissiveBindings : task._opaqueBindings;
        bucket.push(binding);
        task._allBindings.push(binding);
    }
    task._opaqueBindings.sort((a, b) => a.renderable.order - b.renderable.order);
    task._transmissiveBindings.sort((a, b) => a.renderable.order - b.renderable.order);
    task._allBindings.sort((a, b) => a.renderable.order - b.renderable.order);

    task._renderableVersion++;
}

/** Insert a single raw renderable into a task and into the right bucket (with target-binding).
 *  Used by hot paths like processMaterialSwaps that add one mesh after the initial build. */
export function addRenderableToTask(task: RenderPassTask, engine: EngineContextInternal, r: Renderable): void {
    task._renderables.push(r);
    const desc = task.renderTarget.descriptor;
    const target: RenderTargetSignature = {
        colorFormat: desc.colorFormat,
        depthStencilFormat: desc.depthStencilFormat,
        sampleCount: desc.sampleCount,
        flipY: !desc.resolveToSwapchain,
    };
    const binding = r.bind(engine, target);
    if (r.isTransparent) {
        task._transparentBindings.push(binding);
    } else {
        const arr = r.isTransmissive ? task._transmissiveBindings : task._opaqueBindings;
        let i = arr.length;
        while (i > 0 && arr[i - 1]!.renderable.order > r.order) {
            i--;
        }
        arr.splice(i, 0, binding);
    }
    task._allBindings.push(binding);
    task._opaqueBundle = null;
    task._renderableVersion++;
}

/** Remove every binding/renderable matching `mesh` from a task's lists (raw + bucketed). */
export function removeMeshFromTask(task: RenderPassTask, mesh: object): void {
    let removed = false;
    for (let i = task._renderables.length - 1; i >= 0; i--) {
        if (task._renderables[i]!.mesh === mesh) {
            task._renderables.splice(i, 1);
            removed = true;
        }
    }
    for (const arr of [task._opaqueBindings, task._transmissiveBindings, task._transparentBindings, task._allBindings]) {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i]!.renderable.mesh === mesh) {
                arr.splice(i, 1);
                removed = true;
            }
        }
    }
    if (removed) {
        task._opaqueBundle = null;
        task._renderableVersion++;
    }
}

// ── Draw helpers ─────────────────────────────────────────────

function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly DrawBinding[], engine: EngineContextInternal): number {
    let draws = 0;
    let lastPipeline: GPURenderPipeline | null = null;
    let lastShadowBG: GPUBindGroup | null = null;
    for (const b of list) {
        if (b.pipeline !== lastPipeline) {
            enc.setPipeline(b.pipeline);
            lastPipeline = b.pipeline;
        }
        if (b.shadowBG && b.shadowBG !== lastShadowBG) {
            enc.setBindGroup(2, b.shadowBG);
            lastShadowBG = b.shadowBG;
        }
        draws += b.draw(enc, engine);
    }
    return draws;
}

/** Sort transparent bindings by camera distance (back-to-front).
 *  NOTE: today `_sortDistance` is never computed (no renderable provides a sortable
 *  world center via DrawBinding). The comparator collapses to `order` ties. This is
 *  a no-op until transparent depth-sort is wired up per-renderable. */
export function sortTransparents(task: RenderPassTask, _camera: Camera | null): void {
    if (task._transparentBindings.length <= 1) {
        return;
    }
    task._transparentBindings.sort((a, b) => (b._sortDistance ?? 0) - (a._sortDistance ?? 0) || a.renderable.order - b.renderable.order);
}

/**
 * Build the cached render-pass descriptor from the task's render target. Called by
 * `record()` so the descriptor is rebuilt whenever the task is (re)built (e.g. on resize).
 *
 * For swapchain-resolved passes, the swapchain view changes every frame and is patched
 * per-frame in `executeRenderPassTask` (along with the user-mutable `clearColor`).
 */
export function buildRenderPassDescriptor(task: RenderPassTask): void {
    const rt = task.renderTarget;
    const colorAttachments: GPURenderPassColorAttachment[] = [];
    const colorView = rt._colorView; // swapchain view (if any) is patched per-frame in execute
    let colorAttachment: GPURenderPassColorAttachment | null = null;
    if (colorView || rt.descriptor.resolveToSwapchain) {
        colorAttachment = {
            // Placeholder for swapchain-only passes; patched per-frame.
            view: colorView!,
            clearValue: task.clearColor,
            loadOp: "clear",
            storeOp: "store",
        };
        colorAttachments.push(colorAttachment);
    }

    const depthFormat = rt.descriptor.depthStencilFormat;
    const hasStencil = depthFormat ? depthFormat === "depth24plus-stencil8" || depthFormat === "depth32float-stencil8" || depthFormat === "stencil8" : false;
    const depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined = rt._depthView
        ? {
              view: rt._depthView,
              depthClearValue: 1.0,
              depthLoadOp: "clear",
              depthStoreOp: "store",
              ...(hasStencil ? { stencilClearValue: 0, stencilLoadOp: "clear" as const, stencilStoreOp: "store" as const } : {}),
          }
        : undefined;

    task._colorAttachment = colorAttachment;
    task._renderPassDescriptor = { colorAttachments, depthStencilAttachment };
}

/**
 * Execute the render pass task: begin render pass, draw, end.
 * Returns the number of GPU draw calls issued.
 */
export function executeRenderPassTask(task: RenderPassTask, encoder: GPUCommandEncoder): number {
    const rt = task.renderTarget;
    const engine = task.engine;
    const scene = task.scene;
    const swapChainView = engine._swapChainView;

    // Update task-owned scene UBO once per frame from this pass's camera.
    const camera = task.camera ?? scene.camera ?? null;
    writePassSceneUBO(task, engine, scene, camera);

    // Update per-binding UBOs (mesh world matrix + material UBO).
    for (const b of task._allBindings) {
        if (b.updateUBOs) {
            b.updateUBOs();
        }
    }

    // Per-frame mutable updates to the cached descriptor: swapchain view (changes every
    // frame) and user-mutable clearColor. The descriptor itself is built in `record()`.
    if (task._colorAttachment) {
        const att = task._colorAttachment;
        if (rt.descriptor.resolveToSwapchain && swapChainView) {
            if (rt._colorView) {
                // MSAA: swapchain is the resolve target; offscreen MSAA view stays the same.
                att.resolveTarget = swapChainView;
            } else {
                // Non-MSAA: swapchain is the direct color view.
                att.view = swapChainView;
            }
        }
        att.clearValue = task.clearColor;
    }

    const pass = encoder.beginRenderPass(task._renderPassDescriptor!);
    pass.setViewport(0, 0, rt._width, rt._height, 0, 1);

    let drawCalls = 0;

    // ─── Opaque: cached render bundle ─────────────────────────
    // _sceneBG is created up-front in createRenderPassTask and never recreated, so
    // the bundle only needs to be invalidated when the renderable list changes.
    if (task._bundleVersion !== task._renderableVersion || !task._opaqueBundle) {
        const bundleEncoder = engine.device.createRenderBundleEncoder({
            colorFormats: [rt.descriptor.colorFormat],
            depthStencilFormat: rt.descriptor.depthStencilFormat,
            sampleCount: rt.descriptor.sampleCount,
        });
        bundleEncoder.setBindGroup(0, task._sceneBG);
        drawList(bundleEncoder, task._opaqueBindings, engine);
        task._opaqueBundle = bundleEncoder.finish();
        task._bundleVersion = task._renderableVersion;
    }
    drawCalls += task._opaqueBindings.length;
    pass.executeBundles([task._opaqueBundle]);

    // executeBundles does NOT propagate bundle bind-group state to the pass —
    // re-bind group(0) for direct draws.
    if (task._transmissiveBindings.length > 0 || task._transparentBindings.length > 0) {
        pass.setBindGroup(0, task._sceneBG);
    }
    drawCalls += drawList(pass, task._transmissiveBindings, engine);
    drawCalls += drawList(pass, task._transparentBindings, engine);

    pass.end();
    return drawCalls;
}
