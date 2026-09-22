import { describe, expect, it, vi } from "vitest";

import { renderFrame, stopEngine, waitForGpuIdle, type EngineContext, type RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import { disposeEngine } from "../../../packages/babylon-lite/src/engine/engine-dispose";
import { runGpuResourceDisposers } from "../../../packages/babylon-lite/src/engine/gpu-resource-disposal";
import {
    disposeGpuResourceRetirements,
    retireGpuResourceBatch,
    retireGpuResources,
    waitForGpuResourceRetirements,
} from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { syncThinInstanceGpuData } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { VERTEX: number; COPY_DST: number; STORAGE: number; INDIRECT: number };
};
gpuGlobals.GPUBufferUsage ??= { VERTEX: 0x20, COPY_DST: 0x8, STORAGE: 0x80, INDIRECT: 0x100 } as unknown as GPUBufferUsage;

/** Let the retirement flush's deferred work settle.
 *
 *  `flushGpuResourceRetirements` defers via `queueMicrotask`, and only inside that callback does it
 *  acquire the queue fence (`onSubmittedWorkDone()`) and attach the `.then` that finally runs the
 *  batch. So observing the fence takes one turn, and observing the batch takes the fence promise
 *  settling plus another turn — more than a single `await Promise.resolve()` either way. A fixed
 *  number of turns covers both without depending on the exact hop count.
 *
 *  Deliberately timer-free: this drains queued microtasks rather than yielding to a macrotask, which
 *  keeps the test deterministic and off real timers. */
async function flushMicrotasks(turns = 10): Promise<void> {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
    }
}

function makeThinInstances(): ThinInstanceData {
    return {
        matrices: new Float32Array(32),
        count: 2,
        _capacity: 2,
        _version: 2,
        _gpuBuffer: null,
        _gpuVersion: 1,
        _dirtyMin: 0,
        _dirtyMax: 2,
        _colorVersion: 0,
        _colorDirtyMin: 0,
        _colorDirtyMax: 0,
        _colorGpuBuffer: null,
        _colorGpuBufferStorage: false,
        _colorGpuVersion: 0,
        _gpuCullingEnabled: false,
    };
}

describe("GPU resource retirement", () => {
    it("installs one engine lifecycle seam only when retirement work is queued", () => {
        const engine = {} as EngineContext;
        const first = vi.fn();
        const second = vi.fn();
        expect(engine._flushGpuRetirements).toBeUndefined();

        retireGpuResources(engine, first);
        const flush = engine._flushGpuRetirements;
        expect(flush).toBeDefined();

        retireGpuResources(engine, second);
        expect(engine._flushGpuRetirements).toBe(flush);
        disposeGpuResourceRetirements(engine);
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
    });

    it("keeps synchronous engine teardown safe without retaining a disposal seam in ordinary retirement users", async () => {
        let finishFence!: () => void;
        const fence = new Promise<void>((resolve) => {
            finishFence = resolve;
        });
        const inFlight = vi.fn();
        const pending = vi.fn();
        const destroy = vi.fn();
        const unconfigure = vi.fn();
        const surface = {
            _renderingContexts: [],
            _context: { unconfigure },
        };
        const surfaces = [surface] as unknown as EngineContext["_surfaces"];
        const engine = {
            _animFrameId: 0,
            _renderFn: null,
            _surfaces: surfaces,
            _device: { queue: { onSubmittedWorkDone: () => fence }, destroy },
        } as unknown as EngineContext;
        retireGpuResources(engine, inFlight);
        stopEngine(engine);
        retireGpuResources(engine, pending);

        disposeEngine(engine);

        expect(inFlight).toHaveBeenCalledOnce();
        expect(pending).toHaveBeenCalledOnce();
        expect(unconfigure).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
        finishFence();
        await flushMicrotasks();
        expect(inFlight).toHaveBeenCalledOnce();
        expect(pending).toHaveBeenCalledOnce();
    });

    it("snapshots large callback generations without argument spreading or late additions", () => {
        const engine = {} as EngineContext;
        const release = vi.fn();
        const late = vi.fn();
        const callbacks = Array.from({ length: 200_000 }, () => release);
        retireGpuResourceBatch(engine, callbacks);
        callbacks.push(late);
        expect(release).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        expect(release).toHaveBeenCalledTimes(200_000);
        expect(late).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        expect(release).toHaveBeenCalledTimes(200_000);
    });

    it("retires destroyable resources through the same best-effort batch path", () => {
        const engine = {} as EngineContext;
        const destroyable = {
            destroyed: false,
            destroy(): void {
                this.destroyed = true;
            },
        };
        const destroy = vi.spyOn(destroyable, "destroy");
        retireGpuResources(engine, () => runGpuResourceDisposers([destroyable]));
        disposeGpuResourceRetirements(engine);
        expect(destroy).toHaveBeenCalledOnce();
        expect(destroyable.destroyed).toBe(true);
    });

    it("claims stopped-engine retirements before resolving even if the original fence callback is delayed", async () => {
        let finishOriginalFence!: () => void;
        const originalFence = new Promise<void>((resolve) => {
            finishOriginalFence = resolve;
        });
        const onSubmittedWorkDone = vi.fn(async (): Promise<void> => undefined).mockReturnValueOnce(originalFence);
        const engine = { _device: { queue: { onSubmittedWorkDone } } } as unknown as EngineContext;
        const retire = vi.fn();
        retireGpuResources(engine, retire);
        stopEngine(engine);
        await waitForGpuResourceRetirements(engine);
        expect(retire).toHaveBeenCalledOnce();
        expect(engine._retiring?.size).toBe(0);
        finishOriginalFence();
        await flushMicrotasks();
        expect(retire).toHaveBeenCalledOnce();
    });

    it("fences newly queued and nested retirements separately from the captured batch", async () => {
        const fences: (() => void)[] = [];
        const onSubmittedWorkDone = vi.fn(() => new Promise<void>((resolve) => fences.push(resolve)));
        const engine = { _device: { queue: { onSubmittedWorkDone } } } as unknown as EngineContext;
        const nested = vi.fn();
        const addedDuringWait = vi.fn();
        const first = vi.fn(() => retireGpuResources(engine, nested));
        retireGpuResources(engine, first);
        const complete = vi.fn();
        const draining = waitForGpuResourceRetirements(engine).then(complete);
        await flushMicrotasks();
        expect(fences).toHaveLength(2);
        retireGpuResources(engine, addedDuringWait);
        fences[0]!();
        await flushMicrotasks();
        expect(first).toHaveBeenCalledOnce();
        expect(addedDuringWait).not.toHaveBeenCalled();
        expect(nested).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(fences).toHaveLength(4);
        fences[2]!();
        await draining;
        expect(addedDuringWait).toHaveBeenCalledOnce();
        expect(nested).toHaveBeenCalledOnce();
        fences[1]!();
        fences[3]!();
        await flushMicrotasks();
        expect(first).toHaveBeenCalledOnce();
        expect(addedDuringWait).toHaveBeenCalledOnce();
        expect(nested).toHaveBeenCalledOnce();
    });

    it("waits past the current synchronous submission even without retirement callbacks", async () => {
        const events: string[] = [];
        const engine = {
            _device: {
                queue: {
                    onSubmittedWorkDone: vi.fn(async () => {
                        events.push("fence");
                    }),
                },
            },
        } as unknown as EngineContext;
        const draining = waitForGpuResourceRetirements(engine);
        events.push("submit");
        await draining;
        expect(events).toEqual(["submit", "fence"]);
    });

    it("allows concurrent drains and synchronous teardown to claim each callback only once", async () => {
        let finishFence!: () => void;
        const fence = new Promise<void>((resolve) => {
            finishFence = resolve;
        });
        const engine = { _device: { queue: { onSubmittedWorkDone: () => fence } } } as unknown as EngineContext;
        const retire = vi.fn();
        retireGpuResources(engine, retire);
        const first = waitForGpuResourceRetirements(engine);
        const second = waitForGpuResourceRetirements(engine);
        await flushMicrotasks();
        disposeGpuResourceRetirements(engine);
        expect(retire).toHaveBeenCalledOnce();
        finishFence();
        await Promise.all([first, second]);
        expect(retire).toHaveBeenCalledOnce();
    });

    it("preserves unfenced callbacks for teardown when the drain fence rejects", async () => {
        const failure = new Error("queue fence failed");
        const engine = { _device: { queue: { onSubmittedWorkDone: () => Promise.reject(failure) } } } as unknown as EngineContext;
        const retire = vi.fn();
        retireGpuResources(engine, retire);
        await expect(waitForGpuResourceRetirements(engine)).rejects.toBe(failure);
        expect(retire).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        expect(retire).toHaveBeenCalledOnce();
    });

    it("returns the queue fence for all work submitted before the call", () => {
        const submittedWorkDone = Promise.resolve();
        const onSubmittedWorkDone = vi.fn(() => submittedWorkDone);
        const engine = {
            _device: { queue: { onSubmittedWorkDone } },
        } as unknown as EngineContext;

        expect(waitForGpuIdle(engine)).toBe(submittedWorkDone);
        expect(onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    });

    it("does not fence or destroy a replaced buffer until the next frame is submitted", async () => {
        let resolveSubmittedWork!: () => void;
        const submittedWorkDone = new Promise<void>((resolve) => {
            resolveSubmittedWork = resolve;
        });
        const events: string[] = [];
        const oldBuffer = { size: 64, destroy: vi.fn() } as unknown as GPUBuffer;
        const commandBuffer = {} as GPUCommandBuffer;
        const texture = {
            width: 1,
            height: 1,
            createView: vi.fn(() => ({}) as GPUTextureView),
        } as unknown as GPUTexture;
        const renderingContext: RenderingContext = {
            _kind: "test",
            _drawCallsPre: 0,
            clearColor: { r: 0, g: 0, b: 0, a: 1 },
            _update: vi.fn(),
            _record: vi.fn(() => 0),
        };
        const queue = {
            writeBuffer: vi.fn(),
            submit: vi.fn(() => {
                events.push("submit");
            }),
            onSubmittedWorkDone: vi.fn(() => {
                events.push("fence");
                return submittedWorkDone;
            }),
        };
        const engine = {
            canvas: { width: 1, height: 1 },
            format: "bgra8unorm",
            drawCallCount: 0,
            useHighPrecisionMatrix: false,
            useFloatingOrigin: false,
            _device: {
                createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer),
                createCommandEncoder: vi.fn(() => ({ finish: vi.fn(() => commandBuffer) }) as unknown as GPUCommandEncoder),
                queue,
            },
            _context: {
                getCurrentTexture: vi.fn(() => texture),
            },
            scRT: {
                _colorTexture: null,
                _colorView: null,
                _depthTexture: null,
                _depthView: null,
                _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 1, height: 1 } },
                _width: 1,
                _height: 1,
                _eager: true,
            } as unknown as RenderTarget,
            _renderingContexts: [renderingContext],
            _currentEncoder: {} as GPUCommandEncoder,
            _currentDelta: 0,
            _cbs: [],
            _retirements: [],
        } as unknown as EngineContext;
        const surfaces = [engine] as unknown as EngineContext["_surfaces"];
        Object.assign(engine, { engine, surfaces, _surfaces: surfaces });
        const thinInstances = makeThinInstances();
        thinInstances._gpuBuffer = oldBuffer;

        syncThinInstanceGpuData(engine, thinInstances, false);
        await flushMicrotasks();

        expect(queue.onSubmittedWorkDone).not.toHaveBeenCalled();
        expect(oldBuffer.destroy).not.toHaveBeenCalled();

        renderFrame(engine, 16);

        // The fence is acquired in a microtask (so a `stopEngine()` issued from inside
        // `onBeforeRender` still fences behind this frame's submit), so it lands after the submit.
        expect(events).toEqual(["submit"]);
        await flushMicrotasks();
        expect(events).toEqual(["submit", "fence"]);
        expect(oldBuffer.destroy).not.toHaveBeenCalled();

        resolveSubmittedWork();
        await submittedWorkDone;
        await flushMicrotasks();

        expect(oldBuffer.destroy).toHaveBeenCalledTimes(1);
    });

    it("continues draining when one retirement throws", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const afterFailure = vi.fn();
        const engine = {
            _retirements: [],
        } as unknown as EngineContext;
        retireGpuResources(engine, () => {
            throw new Error("already disposed");
        });
        retireGpuResources(engine, afterFailure);

        expect(() => disposeGpuResourceRetirements(engine)).not.toThrow();
        expect(afterFailure).toHaveBeenCalledTimes(1);
        expect(engine._retirements).toBeNull();
        expect(error).toHaveBeenCalledWith("GPU resource retirement failed.", expect.any(Error));
        error.mockRestore();
    });

    it("drains large batches without recursive callback chaining", () => {
        const retire = vi.fn();
        const engine = {
            _retirements: [],
        } as unknown as EngineContext;
        for (let i = 0; i < 20_000; i++) {
            retireGpuResources(engine, retire);
        }

        expect(() => disposeGpuResourceRetirements(engine)).not.toThrow();
        expect(retire).toHaveBeenCalledTimes(20_000);
    });
});
