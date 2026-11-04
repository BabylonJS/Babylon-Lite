import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { runGpuResourceDisposers } from "../engine/gpu-resource-disposal.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, DrawUpdateBatch } from "./renderable.js";

/** @internal Feature-owned state for one binding generation's active update batches. */
export interface DrawBatchState {
    /** @internal Populated only while collecting a candidate generation. */
    _batches: DrawUpdateBatch[];
    /** @internal */
    _reset(): void;
    /** @internal */
    _flush(engine: EngineContext): void;
    /** @internal Select active batches after bindings are removed or transferred. */
    _select(lists: readonly (readonly DrawBinding[])[]): DrawBatchState | undefined;
    /** @internal Omit engine for candidate rollback; committed generations retire behind a fence. */
    _release(engine?: EngineContext, retained?: readonly (DrawBatchState | undefined)[]): void;
}

/** @internal Batch-producing features install their collection and lifetime behavior on demand. */
export function enableDrawBatchCollection(signature: RenderTargetSignature): void {
    signature._collectBatches = collectBatches;
}

function collectBatches(state: DrawBatchState | undefined, binding: DrawBinding): DrawBatchState | undefined {
    if (!binding._updateBatches?.length) {
        return state;
    }
    if (state?._reset !== resetBatches) {
        // Uniform-only states are shared across generations; promotion must not mutate them.
        state = { _batches: state?._batches.slice() ?? [], _reset: resetBatches, _flush: flushBatches, _select: selectBatches, _release: releaseBatches };
    }
    for (const batch of binding._updateBatches) {
        if (!state._batches.includes(batch)) {
            state._batches.push(batch);
        }
    }
    return state;
}

function resetBatches(this: DrawBatchState): void {
    for (const batch of this._batches) {
        batch.reset();
    }
}

function flushBatches(this: DrawBatchState, engine: EngineContext): void {
    for (const batch of this._batches) {
        batch.flush(engine);
    }
}

function selectBatches(lists: readonly (readonly DrawBinding[])[]): DrawBatchState | undefined {
    let state: DrawBatchState | undefined;
    for (const list of lists) {
        for (const binding of list) {
            state = collectBatches(state, binding);
        }
    }
    return state;
}

function releaseBatches(this: DrawBatchState, engine?: EngineContext, retained?: readonly (DrawBatchState | undefined)[]): void {
    const removed = this._batches.filter((batch) => !batch._retired && !retained?.some((state) => state?._batches.includes(batch)));
    if (!removed.length) {
        return;
    }
    for (const batch of removed) {
        if (batch._retired !== undefined) {
            batch._retired = true;
        }
    }
    if (engine) {
        retireGpuResources(engine, () => runGpuResourceDisposers(removed));
    } else {
        runGpuResourceDisposers(removed);
    }
}
