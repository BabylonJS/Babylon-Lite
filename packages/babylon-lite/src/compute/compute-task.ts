import type { EngineContext } from "../engine/engine.js";
import type { ComputePass } from "../frame-graph/compute-pass.js";
import { createComputePass, setComputePassExecuteEnabled, setComputePassExecuteFunc } from "../frame-graph/compute-pass.js";
import type { Task } from "../frame-graph/task.js";
import { _ensureComputeBindingGroups } from "./compute-bindings.js";
import type { ComputeBindingSet } from "./compute-bindings.js";
import type { ComputeDispatch } from "./compute-dispatch.js";
import { _getComputePipeline, prepareComputeShader } from "./compute-shader.js";
import type { ComputeUniformArena } from "./compute-uniform-arena.js";

type ComputeDispatchPrepareRecord = (pass: GPUComputePassEncoder, dispatch: ComputeDispatch) => void;
let _prepareComputeDispatchRecord: ComputeDispatchPrepareRecord | null = null;

/** @internal Install optional per-dispatch recording state. */
export function _installComputeDispatchPrepareRecord(prepare: ComputeDispatchPrepareRecord): void {
    _prepareComputeDispatchRecord = prepare;
}

/** A frame-graph task that records an ordered dispatch list into one compute pass. */
export interface ComputeTask extends Task {
    readonly dispatches: readonly ComputeDispatch[];
    /** Runtime execution gate used by reusable and one-shot compute scheduling. */
    executionEnabled: boolean;
    /** @internal Mutable alias of `dispatches`. */
    readonly _dispatches: ComputeDispatch[];
    /** @internal */
    _pass: ComputePass | null;
    /** @internal Task-owned dynamic uniform arenas. */
    _uniformArenas?: ComputeUniformArena[];
    /** @internal Installed only when task-owned resources are enabled. */
    _flushOwned?: () => void;
    /** @internal Installed only when task-owned resources are enabled. */
    _disposeOwned?: () => void;
    /** @internal Installed only by the opt-in one-shot module. */
    _oneShotRecorded?: (encoder: GPUCommandEncoder) => void;
    /** @internal Installed only by the opt-in one-shot module. */
    _oneShotDispose?: () => void;
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

/** Create an empty compute scheduling task. */
export function createComputeTask(engine: EngineContext, name = "compute"): ComputeTask {
    const dispatches: ComputeDispatch[] = [];
    const validatedBindings = new Set<ComputeBindingSet>();
    const task: ComputeTask = {
        name,
        engine,
        dispatches,
        executionEnabled: true,
        _dispatches: dispatches,
        _passes: [],
        _pass: null,
        _disposed: false,
        _preload(): Promise<void> {
            return prepareComputeTask(task);
        },
        record(): void {
            if (task._disposed) {
                throw new Error(`ComputeTask "${task.name}" has been disposed.`);
            }
            task._pass?._dispose();
            const pass = createComputePass(task.name, task);
            task._pass = pass;
            const lastGroups: (GPUBindGroup | null)[] = [];
            const lastOffsets: (readonly number[] | null)[] = [];
            setComputePassExecuteEnabled(pass, () => {
                if (!task.executionEnabled) {
                    return false;
                }
                for (let i = 0; i < dispatches.length; i++) {
                    if (dispatches[i]!.enabled) {
                        return true;
                    }
                }
                task._oneShotRecorded?.(task.engine._currentEncoder);
                return false;
            });
            setComputePassExecuteFunc(pass, (encoder) => {
                validatedBindings.clear();
                lastGroups.fill(null);
                lastOffsets.fill(null);
                let lastPipeline: GPUComputePipeline | null = null;
                let lastShader: ComputeDispatch["shader"] | null = null;
                for (let i = 0; i < dispatches.length; i++) {
                    const dispatch = dispatches[i]!;
                    if (!dispatch.enabled) {
                        continue;
                    }
                    if (dispatch.shader !== lastShader) {
                        lastGroups.fill(null);
                        lastOffsets.fill(null);
                        lastShader = dispatch.shader;
                    }
                    const pipeline = dispatch._getPipeline?.() ?? _getComputePipeline(dispatch.shader);
                    if (pipeline !== lastPipeline) {
                        encoder.setPipeline(pipeline);
                        lastPipeline = pipeline;
                    }
                    const validateBindings = !validatedBindings.has(dispatch.bindings);
                    if (validateBindings) {
                        validatedBindings.add(dispatch.bindings);
                    }
                    const groups = _ensureComputeBindingGroups(dispatch.bindings, validateBindings);
                    for (let group = 0; group < groups.length; group++) {
                        const bindGroup = groups[group]!;
                        const offsets = dispatch._dynamicOffsets?.[group] ?? dispatch.bindings._zeroDynamicOffsets?.[group] ?? null;
                        if (lastGroups[group] === bindGroup && (offsets ? offsetsEqual(lastOffsets[group] ?? null, offsets) : lastOffsets[group] === null)) {
                            continue;
                        }
                        if (offsets) {
                            encoder.setBindGroup(group, bindGroup, offsets);
                        } else {
                            encoder.setBindGroup(group, bindGroup);
                        }
                        lastGroups[group] = bindGroup;
                        lastOffsets[group] = offsets;
                    }
                    _prepareComputeDispatchRecord?.(encoder, dispatch);
                    if (dispatch._record) {
                        dispatch._record(encoder, dispatch);
                    } else {
                        encoder.dispatchWorkgroups(dispatch._x, dispatch._y, dispatch._z);
                    }
                }
                task._oneShotRecorded?.(task.engine._currentEncoder);
            });
            pass._beforeExecute = () => task._flushOwned?.();
        },
        dispose(): void {
            if (task._disposed) {
                return;
            }
            task._oneShotDispose?.();
            task._pass?._dispose();
            task._pass = null;
            task._passes.length = 0;
            task._dispatches.length = 0;
            task._disposeOwned?.();
            task._uniformArenas = undefined;
            task._flushOwned = undefined;
            task._disposeOwned = undefined;
            task._oneShotRecorded = undefined;
            task._oneShotDispose = undefined;
            task._disposed = true;
        },
    };
    return task;
}

/** Append a dispatch to a task without transferring ownership. */
export function addComputeDispatch(task: ComputeTask, dispatch: ComputeDispatch): void {
    if (task._disposed) {
        throw new Error(`ComputeTask "${task.name}" has been disposed.`);
    }
    if (dispatch.shader._engine !== task.engine) {
        throw new Error(`ComputeTask "${task.name}" and its dispatch belong to different engines.`);
    }
    if (!task._dispatches.includes(dispatch)) {
        task._dispatches.push(dispatch);
    }
}

/** Remove a dispatch from a task. Idempotent. */
export function removeComputeDispatch(task: ComputeTask, dispatch: ComputeDispatch): void {
    const index = task._dispatches.indexOf(dispatch);
    if (index >= 0) {
        task._dispatches.splice(index, 1);
    }
}

/** Submit recorded compute tasks immediately, without rendering a frame or acquiring a swapchain texture. */
export function submitComputeTasks(tasks: readonly ComputeTask[]): void {
    if (tasks.length === 0) {
        return;
    }
    const engine = tasks[0]!.engine;
    let hasEnabledTask = false;
    for (const task of tasks) {
        if (task.engine !== engine) {
            throw new Error("submitComputeTasks requires tasks from the same engine.");
        }
        if (task._disposed || !task._pass) {
            throw new Error(`ComputeTask "${task.name}" must be recorded and active before direct submission.`);
        }
        hasEnabledTask ||= task.executionEnabled !== false;
    }
    if (engine._currentEncoder) {
        throw new Error("submitComputeTasks cannot run while a frame is being recorded.");
    }
    if (!hasEnabledTask) {
        return;
    }
    const encoder = engine._device.createCommandEncoder({ label: "direct-compute-tasks" });
    engine._currentEncoder = encoder;
    try {
        for (const task of tasks) {
            if (task.executionEnabled !== false) {
                task._pass!._execute();
            }
        }
    } finally {
        engine._currentEncoder = undefined!;
    }
    engine._device.queue.submit([encoder.finish()]);
    engine._computeOneShotSubmitted?.(encoder);
}

/** Prepare every pipeline variant and binding set used by a task. */
export async function prepareComputeTask(task: ComputeTask): Promise<void> {
    if (task._disposed) {
        throw new Error(`ComputeTask "${task.name}" has been disposed.`);
    }
    const pending: Promise<void>[] = [];
    for (const dispatch of task._dispatches) {
        _ensureComputeBindingGroups(dispatch.bindings);
        pending.push(dispatch._preparePipeline?.() ?? prepareComputeShader(dispatch.shader));
    }
    await Promise.all(pending);
}
