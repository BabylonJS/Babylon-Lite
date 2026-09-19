/**
 * ComputePass — a frame-graph pass that records compute work into the engine's
 * current frame command encoder.
 *
 * A compute task owns one pass. Separate tasks create separate pass boundaries
 * when ordering relative to render or copy work requires them.
 */

import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { Pass } from "./pass.js";
import type { Task } from "./task.js";

/** Body of a compute pass. */
export type ComputePassExecuteFunc = (pass: GPUComputePassEncoder) => void;

/** A frame-graph pass that brackets one WebGPU compute pass. */
export interface ComputePass extends Pass {
    /** @internal Body of the compute pass. */
    _computeExecute: ComputePassExecuteFunc | null;
    /** @internal Fast preflight that avoids opening an empty pass. */
    _executeEnabled: (() => boolean) | null;
}

/** @internal Create an empty compute pass owned by `task`. */
export function createComputePass(name: string, task: Task): ComputePass {
    const pass: ComputePass = {
        name,
        _parentTask: task,
        _dependencies: new Set<RenderTarget>(),
        _executeFunc: null,
        _computeExecute: null,
        _executeEnabled: null,
        _beforeExecute: null,
        _initialize(): void {
            // Compute passes have no render-target descriptor to initialize.
        },
        _execute(): number {
            if (pass._executeEnabled && !pass._executeEnabled()) {
                return 0;
            }
            pass._beforeExecute?.();
            const encoder = (pass._parentTask.engine as EngineContext)._currentEncoder.beginComputePass({ label: pass.name });
            pass._computeExecute?.(encoder);
            encoder.end();
            return 0;
        },
        _dispose(): void {
            pass._executeFunc = null;
            pass._computeExecute = null;
            pass._executeEnabled = null;
            pass._beforeExecute = null;
            pass._dependencies.clear();
        },
    };
    task._passes.push(pass);
    return pass;
}

/** @internal Set the per-frame body of a compute pass. */
export function setComputePassExecuteFunc(pass: ComputePass, fn: ComputePassExecuteFunc): void {
    pass._computeExecute = fn;
}

/** @internal Set a preflight predicate that skips the whole pass when no work is active. */
export function setComputePassExecuteEnabled(pass: ComputePass, enabled: () => boolean): void {
    pass._executeEnabled = enabled;
}
