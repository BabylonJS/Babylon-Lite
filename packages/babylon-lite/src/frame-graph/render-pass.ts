/**
 * RenderPass — a frame-graph pass that begins a render pass into its bound
 * `RenderTarget`, runs a user-supplied execute callback, then ends the pass.
 *
 * Modelled on Babylon.js' `FrameGraphRenderPass`, with two intentional
 * Lite-flavoured differences:
 *   - No shared `FrameGraphRenderContext`. The pass owns its descriptor and
 *     passes the live render-pass encoder directly to its base `_executeFunc`.
 *   - No numeric `TextureHandle` indirection — `_renderTarget` /
 *     `_renderTargetDepth` are `RenderTarget` references. The handle layer
 *     lands later as part of texture virtualization; the call sites it will
 *     touch are isolated to `setRenderPassRenderTarget` /
 *     `setRenderPassRenderTargetDepth` and the `_initialize` body.
 *
 * Per-frame behavior (`_execute`):
 *   1. Patch the cached color attachment with this frame's `clearColor` /
 *      `loadOp` and (in swapchain mode) the per-frame swap view.
 *   2. `enc = encoder.beginRenderPass(_renderPassDescriptor)`.
 *   3. `_executeFunc(enc)` issues the actual draws (or skipped if unset).
 *   4. `enc.end()`.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { addPassDependencies, type Pass } from "./pass.js";
import type { Task } from "./task.js";

export interface RenderPass extends Pass {
    /** Color render target. `null` until set via `setRenderPassRenderTarget`. */
    _renderTarget: RenderTarget | null;

    /** Optional separate depth target. When `null`, the depth view is taken
     *  from `_renderTarget` (today's combined-RT behavior). Mirrors BJS'
     *  `setRenderTargetDepth`. */
    _renderTargetDepth: RenderTarget | null;

    /** Cached descriptor + attachments — built once in `_initialize`, then
     *  patched per-frame in `_execute` for swapchain mode + clearColor +
     *  loadOp. */
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment | null;
    _depthAttachment: GPURenderPassDepthStencilAttachment | null;

    /** Per-frame mutable state. RenderTask mirrors live scene state
     *  (e.g. `scene.clearColor` for auto-filled tasks) into these fields
     *  before iterating its passes. */
    clearColor: GPUColorDict;
    /** True → loadOp `"clear"`, false → `"load"` (overlay mode). */
    clear: boolean;

    /** Cached at descriptor build — `_renderTarget.descriptor.resolveToSwapchain`. */
    _swapchain: boolean;
    /** Cached at descriptor build — `_renderTarget.descriptor.sampleCount`. */
    _sampleCount: number;
}

const DEFAULT_CLEAR_COLOR: GPUColorDict = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

/** Create a new render pass owned by `task` and append it to `task._passes`.
 *  The pass is empty — the caller must wire its render target
 *  (`setRenderPassRenderTarget`), execute body (`setRenderPassExecuteFunc`),
 *  and clear state before the frame graph initializes / executes. */
export function createRenderPass(name: string, task: Task): RenderPass {
    const pass: RenderPass = {
        name,
        _parentTask: task,
        _dependencies: new Set<RenderTarget>(),
        _renderTarget: null,
        _renderTargetDepth: null,
        _renderPassDescriptor: { colorAttachments: [] },
        _colorAttachment: null,
        _depthAttachment: null,
        clearColor: { ...DEFAULT_CLEAR_COLOR },
        clear: true,
        _swapchain: false,
        _sampleCount: 1,
        _executeFunc: null,
        _beforeExecute: null,
        _initialize(): void {
            // Assemble the cached `GPURenderPassDescriptor` and color/depth
            // attachments from the bound RTs.
            const rt = pass._renderTarget;
            if (!rt) {
                throw new Error(`RenderPass "${pass.name}": render target not set`);
            }
            const swapchain = rt._descriptor.resolveToSwapchain === true;
            const colorView = rt._colorView;
            let colorAttachment: GPURenderPassColorAttachment | null = null;
            if (colorView || swapchain) {
                colorAttachment = {
                    view: colorView!,
                    loadOp: pass.clear ? "clear" : "load",
                    storeOp: "store",
                    clearValue: pass.clearColor,
                };
            }
            const depthRt = pass._renderTargetDepth ?? rt;
            const depthFormat = depthRt._descriptor.depthStencilFormat;
            const depthView = depthRt._depthView;
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
            pass._colorAttachment = colorAttachment;
            pass._depthAttachment = depthAttachment;
            pass._renderPassDescriptor = {
                label: pass.name,
                colorAttachments: colorAttachment ? [colorAttachment] : [],
                depthStencilAttachment: depthAttachment ?? undefined,
            };
            pass._swapchain = swapchain;
            pass._sampleCount = rt._descriptor.sampleCount ?? 1;
        },
        _execute(): number {
            const rt = pass._renderTarget;
            if (!rt) {
                return 0;
            }
            pass._beforeExecute?.();
            const eng = pass._parentTask.engine as EngineContextInternal;
            const att = pass._colorAttachment;
            if (att) {
                att.clearValue = pass.clearColor;
                att.loadOp = pass.clear ? "clear" : "load";
                if (pass._swapchain) {
                    const swapView = eng._swapchainView;
                    if (pass._sampleCount > 1) {
                        att.resolveTarget = swapView;
                    } else {
                        att.view = swapView;
                    }
                }
            }
            const enc = eng._currentEncoder.beginRenderPass(pass._renderPassDescriptor);
            let draws = 0;
            if (pass._executeFunc) {
                draws = pass._executeFunc(enc);
            }
            enc.end();
            return draws;
        },
        _dispose(): void {
            pass._renderTarget = null;
            pass._renderTargetDepth = null;
            pass._colorAttachment = null;
            pass._depthAttachment = null;
            pass._renderPassDescriptor = { colorAttachments: [] };
            pass._executeFunc = null;
            pass._beforeExecute = null;
            pass._dependencies.clear();
        },
    };
    task._passes.push(pass);
    return pass;
}

/** Set the color render target. Mirrors BJS `setRenderTarget`. */
export function setRenderPassRenderTarget(pass: RenderPass, rt: RenderTarget): void {
    pass._renderTarget = rt;
    addPassDependencies(pass, rt);
}

/** Set an optional separate depth render target. Mirrors BJS
 *  `setRenderTargetDepth`. When unset, depth comes from the color RT. */
export function setRenderPassRenderTargetDepth(pass: RenderPass, rt: RenderTarget): void {
    pass._renderTargetDepth = rt;
    addPassDependencies(pass, rt);
}

/** Set color clear/load state. `clear === true` → loadOp `"clear"`,
 *  `false` → `"load"` (overlay mode — keeps previous attachment contents). */
export function setRenderPassClear(pass: RenderPass, clear: boolean, clearColor: GPUColorDict): void {
    pass.clear = clear;
    pass.clearColor = clearColor;
}
