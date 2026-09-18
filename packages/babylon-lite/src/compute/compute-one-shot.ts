import type { EngineContext } from "../engine/engine.js";
import { addFramePostSubmitHook } from "../engine/frame-post-submit.js";
import type { ComputeTask } from "./compute-task.js";

declare const computeOneShotBrand: unique symbol;
let _engineStates: WeakMap<EngineContext, ComputeOneShotEngineState> | null = null;

interface ComputeOneShotEngineState {
    readonly engine: EngineContext;
    readonly shots: Set<ComputeOneShot>;
    readonly recordedByEncoder: WeakMap<GPUCommandEncoder, Map<ComputeOneShot, number>>;
    removeFramePostSubmit: () => void;
}

/** One-shot scheduling state for a compute task on its current device. */
export interface ComputeOneShot {
    readonly [computeOneShotBrand]: true;
    readonly task: ComputeTask;
    /** Promise for the currently armed execution. */
    completion: Promise<void>;
    /** @internal */
    _generation: number;
    /** @internal */
    _armed: boolean;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _resolve: (() => void) | null;
    /** @internal */
    _reject: ((reason?: unknown) => void) | null;
}

function stateFor(engine: EngineContext): ComputeOneShotEngineState {
    const states = (_engineStates ??= new WeakMap());
    let state = states.get(engine);
    if (!state) {
        state = { engine, shots: new Set(), recordedByEncoder: new WeakMap(), removeFramePostSubmit: () => {} };
        states.set(engine, state);
        engine._computeOneShotSubmitted = (encoder) => completeSubmittedOneShots(state!, encoder);
        state.removeFramePostSubmit = addFramePostSubmitHook(engine, () => completeSubmittedOneShots(state!, engine._currentEncoder));
    }
    return state;
}

function completeSubmittedOneShots(state: ComputeOneShotEngineState, encoder: GPUCommandEncoder): void {
    const batch = state.recordedByEncoder.get(encoder);
    if (!batch) {
        return;
    }
    state.recordedByEncoder.delete(encoder);
    const completions: { resolve: (() => void) | null; reject: ((reason?: unknown) => void) | null }[] = [];
    for (const [oneShot, generation] of batch) {
        if (!oneShot._armed || oneShot._disposed || oneShot._generation !== generation) {
            continue;
        }
        oneShot.task.executionEnabled = false;
        oneShot._armed = false;
        completions.push({ resolve: oneShot._resolve, reject: oneShot._reject });
        oneShot._resolve = null;
        oneShot._reject = null;
    }
    if (completions.length) {
        void state.engine._device.queue.onSubmittedWorkDone().then(
            () => completions.forEach(({ resolve }) => resolve?.()),
            (error) => completions.forEach(({ reject }) => reject?.(error))
        );
    }
}

function rejectPending(oneShot: ComputeOneShot, error: unknown): void {
    oneShot._armed = false;
    oneShot.task.executionEnabled = false;
    oneShot._reject?.(error);
    oneShot._resolve = null;
    oneShot._reject = null;
}

function releaseState(engine: EngineContext, state: ComputeOneShotEngineState): void {
    if (state.shots.size === 0) {
        engine._computeOneShotSubmitted = undefined;
        state.removeFramePostSubmit();
        _engineStates?.delete(engine);
    }
}

function armInternal(oneShot: ComputeOneShot): Promise<void> {
    if (oneShot._disposed) {
        return Promise.reject(new Error("ComputeOneShot has been disposed."));
    }
    if (oneShot.task._disposed) {
        return Promise.reject(new Error(`ComputeTask "${oneShot.task.name}" has been disposed.`));
    }
    if (oneShot._armed) {
        return oneShot.completion;
    }
    const generation = ++oneShot._generation;
    oneShot._armed = true;
    oneShot.task.executionEnabled = true;
    oneShot.completion = new Promise<void>((resolve, reject) => {
        oneShot._resolve = resolve;
        oneShot._reject = reject;
    });
    const state = stateFor(oneShot.task.engine);
    oneShot.task._oneShotRecorded = (encoder) => {
        if (!oneShot._armed || oneShot._generation !== generation) {
            return;
        }
        let batch = state.recordedByEncoder.get(encoder);
        if (!batch) {
            batch = new Map();
            state.recordedByEncoder.set(encoder, batch);
        }
        batch.set(oneShot, generation);
    };
    oneShot.completion.catch(() => undefined);
    return oneShot.completion;
}

/** Configure a compute task to execute once on the current device. */
export function createComputeOneShot(task: ComputeTask): ComputeOneShot {
    if (task._disposed) {
        throw new Error(`ComputeTask "${task.name}" has been disposed.`);
    }
    if (task._oneShotRecorded) {
        throw new Error(`ComputeTask "${task.name}" already has one-shot scheduling.`);
    }
    const oneShot = {
        task,
        completion: Promise.resolve(),
        _generation: 0,
        _armed: false,
        _disposed: false,
        _resolve: null,
        _reject: null,
    } as unknown as ComputeOneShot;
    const state = stateFor(task.engine);
    state.shots.add(oneShot);
    task._oneShotDispose = () => disposeComputeOneShot(oneShot);
    void armInternal(oneShot);
    return oneShot;
}

/** Arm another one-shot execution and resolve after its submitted GPU work completes. */
export function armComputeOneShot(oneShot: ComputeOneShot): Promise<void> {
    return armInternal(oneShot);
}

/** Detach one-shot scheduling without disposing the task. */
export function disposeComputeOneShot(oneShot: ComputeOneShot): void {
    if (oneShot._disposed) {
        return;
    }
    oneShot._disposed = true;
    if (oneShot._armed) {
        rejectPending(oneShot, new Error("ComputeOneShot was disposed before submission."));
    }
    oneShot.task._oneShotRecorded = undefined;
    oneShot.task._oneShotDispose = undefined;
    const state = _engineStates?.get(oneShot.task.engine);
    state?.shots.delete(oneShot);
    if (state) {
        releaseState(oneShot.task.engine, state);
    }
}
