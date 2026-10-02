import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget } from "../engine/render-target.js";
import type { Task } from "../frame-graph/task.js";
import { _ensureComputeBindingGroups } from "../compute/compute-bindings.js";
import type { ComputeBindingSet } from "../compute/compute-bindings.js";
import { _getStorageBufferHandle } from "../resource/storage-buffer.js";
import type { RenderDraw } from "./render-draw.js";
import { _getRenderPipeline } from "./render-shader.js";

/** Configuration for {@link createRenderDrawTask}. */
export interface RenderDrawTaskConfig {
    readonly name?: string;
    /** Borrowed target: the task never disposes it. Swap it per frame with {@link setRenderDrawTaskTarget}. */
    readonly target: RenderTarget;
    /** Clear the target before drawing (`true`) or draw over its contents (`false`, the default). */
    readonly clear?: boolean;
    readonly clearColor?: GPUColorDict;
}

/** A frame-graph task that records an ordered list of draws into one render pass on one target. */
export interface RenderDrawTask extends Task {
    readonly draws: readonly RenderDraw[];
    /** Current target; change it with {@link setRenderDrawTaskTarget}. */
    readonly target: RenderTarget;
    /** Runtime execution gate, as on every task. */
    executionEnabled: boolean;
    /** Load op of the next frames: `true` clears, `false` keeps the target's contents. */
    clear: boolean;
    clearColor: GPUColorDict;
    /** @internal Mutable alias of `draws`. */
    readonly _draws: RenderDraw[];
    /** @internal Mutable alias of `target`; both are written together by {@link setRenderDrawTaskTarget}. */
    _target: RenderTarget;
    /** @internal Descriptor reused every frame; only views and load ops are patched. */
    _descriptor: GPURenderPassDescriptor;
    /** @internal */
    _colorAttachment: GPURenderPassColorAttachment | null;
    /** @internal */
    _depthAttachment: GPURenderPassDepthStencilAttachment | null;
    /** @internal */
    _disposed: boolean;
}

function offsetsEqual(a: readonly number[] | null, b: readonly number[]): boolean {
    if (!a || a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < b.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function buildAttachments(task: RenderDrawTask): void {
    const target = task._target;
    task._colorAttachment = target._descriptor.format ? { view: target._colorView!, loadOp: "load", storeOp: "store" } : null;
    task._depthAttachment = target._descriptor.dFormat ? { view: target._depthView!, depthLoadOp: "load", depthStoreOp: "store" } : null;
    task._descriptor = {
        label: task.name,
        colorAttachments: task._colorAttachment ? [task._colorAttachment] : [],
        depthStencilAttachment: task._depthAttachment ?? undefined,
    };
}

/** Create a task that draws reusable {@link RenderDraw}s into a render target, in the frame's command encoder. */
export function createRenderDrawTask(engine: EngineContext, config: RenderDrawTaskConfig): RenderDrawTask {
    const draws: RenderDraw[] = [];
    const validated = new Set<ComputeBindingSet>();
    const lastGroups: (GPUBindGroup | null)[] = [];
    const lastOffsets: (readonly number[] | null)[] = [];
    const task = {
        name: config.name ?? "render-draws",
        engine,
        draws,
        _draws: draws,
        executionEnabled: true,
        clear: config.clear ?? false,
        clearColor: config.clearColor ?? { r: 0, g: 0, b: 0, a: 0 },
        _passes: [],
        _disposed: false,
        record(): void {
            if (task._disposed) {
                throw new Error(`RenderDrawTask "${task.name}" has been disposed.`);
            }
            const target = task._target;
            // Borrowed targets are normally allocated already (render-target textures, texture layers, the
            // swapchain); a plain descriptor that was never built is allocated once, and stays caller-owned.
            if (!target._colorView && !target._depthView) {
                buildRenderTarget(target, engine);
            }
            buildAttachments(task);
        },
        execute(): number {
            let active = false;
            for (let i = 0; i < draws.length; i++) {
                if (draws[i]!.enabled) {
                    active = true;
                    break;
                }
            }
            if (!active && !task.clear) {
                return 0;
            }
            const target = task._target;
            const color = task._colorAttachment;
            if (color) {
                // Re-read every frame: the swapchain target is re-acquired per frame.
                color.view = target._colorView!;
                color.loadOp = task.clear ? "clear" : "load";
                color.clearValue = task.clearColor;
            }
            const depth = task._depthAttachment;
            if (depth) {
                depth.view = target._depthView!;
                depth.depthLoadOp = task.clear ? "clear" : "load";
                depth.depthClearValue = target._descriptor.depthClearValue ?? 0;
            }
            const pass = engine._currentEncoder.beginRenderPass(task._descriptor);
            validated.clear();
            lastGroups.fill(null);
            lastOffsets.fill(null);
            let lastPipeline: GPURenderPipeline | null = null;
            let drawCalls = 0;
            for (let i = 0; i < draws.length; i++) {
                const draw = draws[i]!;
                if (!draw.enabled) {
                    continue;
                }
                const pipeline = _getRenderPipeline(draw.shader, target);
                if (pipeline !== lastPipeline) {
                    pass.setPipeline(pipeline);
                    lastPipeline = pipeline;
                    // A new pipeline may have a different layout: rebind every group.
                    lastGroups.fill(null);
                    lastOffsets.fill(null);
                }
                const set = draw.bindings._set;
                const validate = !validated.has(set);
                if (validate) {
                    validated.add(set);
                }
                const groups = _ensureComputeBindingGroups(set, validate);
                for (let group = 0; group < groups.length; group++) {
                    const bindGroup = groups[group]!;
                    const offsets = draw._dynamicOffsets?.[group] ?? set._zeroDynamicOffsets?.[group] ?? null;
                    if (lastGroups[group] === bindGroup && (offsets ? offsetsEqual(lastOffsets[group] ?? null, offsets) : lastOffsets[group] === null)) {
                        continue;
                    }
                    if (offsets) {
                        pass.setBindGroup(group, bindGroup, offsets);
                    } else {
                        pass.setBindGroup(group, bindGroup);
                    }
                    lastGroups[group] = bindGroup;
                    lastOffsets[group] = offsets;
                }
                const vertexBuffers = draw._vertexBuffers;
                for (let slot = 0; slot < vertexBuffers.length; slot++) {
                    pass.setVertexBuffer(slot, _getStorageBufferHandle(engine, vertexBuffers[slot]!));
                }
                const indexBuffer = draw._indexBuffer;
                if (indexBuffer) {
                    pass.setIndexBuffer(_getStorageBufferHandle(engine, indexBuffer), draw._indexFormat);
                }
                if (draw._record) {
                    draw._record(pass, draw);
                } else if (indexBuffer) {
                    pass.drawIndexed(draw._vertexCount, draw._instanceCount, draw._firstVertex, 0, draw._firstInstance);
                } else {
                    pass.draw(draw._vertexCount, draw._instanceCount, draw._firstVertex, draw._firstInstance);
                }
                drawCalls++;
            }
            pass.end();
            return drawCalls;
        },
        dispose(): void {
            task._draws.length = 0;
            task._colorAttachment = null;
            task._depthAttachment = null;
            task._disposed = true;
        },
    } as unknown as RenderDrawTask;
    task._target = (task as { target: RenderTarget }).target = config.target;
    buildAttachments(task);
    return task;
}

/** Append a draw to the task's ordered list, without transferring ownership. Idempotent. */
export function addRenderDraw(task: RenderDrawTask, draw: RenderDraw): void {
    if (task._disposed) {
        throw new Error(`RenderDrawTask "${task.name}" has been disposed.`);
    }
    if (draw.shader._program._engine !== task.engine) {
        throw new Error(`RenderDrawTask "${task.name}" and its draw belong to different engines.`);
    }
    if (!task._draws.includes(draw)) {
        task._draws.push(draw);
    }
}

/** Remove a draw from the task. Idempotent. */
export function removeRenderDraw(task: RenderDrawTask, draw: RenderDraw): void {
    const index = task._draws.indexOf(draw);
    if (index >= 0) {
        task._draws.splice(index, 1);
    }
}

/**
 * Point the task at another borrowed target, for example the next tile layer. Targets of the same format
 * reuse the same pipelines; nothing is allocated unless the attachment set (color, depth) changes.
 */
export function setRenderDrawTaskTarget(task: RenderDrawTask, target: RenderTarget): void {
    const previous = task._target;
    task._target = (task as { target: RenderTarget }).target = target;
    if (!!previous._descriptor.format !== !!target._descriptor.format || !!previous._descriptor.dFormat !== !!target._descriptor.dFormat) {
        buildAttachments(task);
    }
}
