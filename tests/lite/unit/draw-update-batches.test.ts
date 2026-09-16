import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { enableDrawBatchCollection, type DrawBatchState } from "../../../packages/babylon-lite/src/render/draw-update-batches";
import type { DrawBinding, DrawUpdateBatch } from "../../../packages/babylon-lite/src/render/renderable";

function batch(): DrawUpdateBatch {
    return { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
}

function binding(batches?: DrawUpdateBatch[]): DrawBinding {
    return { _updateBatches: batches } as DrawBinding;
}

function collect(...bindings: DrawBinding[]): DrawBatchState | undefined {
    const signature: RenderTargetSignature = { _sampleCount: 1 };
    enableDrawBatchCollection(signature);
    let state: DrawBatchState | undefined;
    for (const value of bindings) {
        state = signature._collectBatches!(state, value);
    }
    return state;
}

describe("opt-in draw update batches", () => {
    it("creates no state for bindings without batches and deduplicates active batches", () => {
        const signature: RenderTargetSignature = { _sampleCount: 1 };
        expect(signature._collectBatches).toBeUndefined();
        expect(collect(binding())).toBeUndefined();
        const active = batch();
        const state = collect(binding([active]), binding([active]))!;
        expect(state._batches).toEqual([active]);
        const engine = {} as EngineContext;
        state._reset();
        state._flush(engine);
        expect(active.reset).toHaveBeenCalledOnce();
        expect(active.flush).toHaveBeenCalledExactlyOnceWith(engine);
    });

    it("promotes an existing feature-specific state before adding another batch", () => {
        const signature: RenderTargetSignature = { _sampleCount: 1 };
        const first = batch();
        const second = batch();
        const state = {
            _batches: [first],
            _reset: first.reset,
            _flush: first.flush,
            _select: vi.fn(),
            _release: vi.fn(),
        } satisfies DrawBatchState;
        Object.freeze(state._batches);
        Object.freeze(state);
        enableDrawBatchCollection(signature);
        const promoted = signature._collectBatches!(state, binding([second]))!;
        const engine = {} as EngineContext;
        promoted._reset();
        promoted._flush(engine);
        expect(promoted._batches).toEqual([first, second]);
        expect(promoted).not.toBe(state);
        expect(state._batches).toEqual([first]);
        expect(state._reset).toBe(first.reset);
        expect(first.reset).toHaveBeenCalledOnce();
        expect(second.reset).toHaveBeenCalledOnce();
        expect(first.flush).toHaveBeenCalledExactlyOnceWith(engine);
        expect(second.flush).toHaveBeenCalledExactlyOnceWith(engine);
    });

    it("selects a new generation without mutating the previous collection", () => {
        const first = batch();
        const second = batch();
        const state = collect(binding([first, second]))!;
        const selected = state._select([[binding([second])]]);
        expect(selected?._batches).toEqual([second]);
        expect(state._batches).toEqual([first, second]);
        expect(state._select([[]])).toBeUndefined();
    });

    it("rolls back only batches absent from every retained task", () => {
        const source = batch();
        const destination = batch();
        const candidate = batch();
        candidate.destroy = vi.fn(function (this: DrawUpdateBatch) {
            expect(this).toBe(candidate);
        });
        const sourceState = collect(binding([source]))!;
        const destinationState = collect(binding([destination]))!;
        const staged = collect(binding([source, destination, candidate]))!;
        staged._release(undefined, [undefined, sourceState, destinationState]);
        expect(candidate.destroy).toHaveBeenCalledOnce();
        expect(source.destroy).not.toHaveBeenCalled();
        expect(destination.destroy).not.toHaveBeenCalled();
    });

    it("defers obsolete resource releases and snapshots the binding's input array", () => {
        const engine = {} as EngineContext;
        const retired = { ...batch(), _retired: false };
        const retained = batch();
        const late = batch();
        const input = [retired, retained];
        const previous = collect(binding(input))!;
        const next = collect(binding([retained]))!;
        previous._release(engine, [next]);
        previous._release(engine, [next]);
        input.push(late);
        expect(retired.destroy).not.toHaveBeenCalled();
        expect(retired._retired).toBe(true);
        disposeGpuResourceRetirements(engine);
        disposeGpuResourceRetirements(engine);
        expect(retired.destroy).toHaveBeenCalledOnce();
        expect(retained.destroy).not.toHaveBeenCalled();
        expect(late.destroy).not.toHaveBeenCalled();
    });
});
