import { describe, expect, it, vi } from "vitest";

import { renderFrame, type EngineContext, type RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import { disposeGpuResourceRetirements, retireGpuResources } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { syncThinInstanceGpuData } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { VERTEX: number; COPY_DST: number; STORAGE: number; INDIRECT: number };
};
gpuGlobals.GPUBufferUsage ??= { VERTEX: 0x20, COPY_DST: 0x8, STORAGE: 0x80, INDIRECT: 0x100 } as unknown as GPUBufferUsage;

function makeThinInstances(): ThinInstanceData {
    return {
        matrices: new Float32Array(32),
        count: 2,
        _capacity: 2,
        _version: 2,
        _gpuBuffer: null,
        _gpuBufferStorage: false,
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
        await Promise.resolve();

        expect(queue.onSubmittedWorkDone).not.toHaveBeenCalled();
        expect(oldBuffer.destroy).not.toHaveBeenCalled();

        renderFrame(engine, 16);

        expect(events).toEqual(["submit", "fence"]);
        expect(oldBuffer.destroy).not.toHaveBeenCalled();

        resolveSubmittedWork();
        await submittedWorkDone;
        await Promise.resolve();

        expect(oldBuffer.destroy).toHaveBeenCalledTimes(1);
    });

    it("continues draining when one retirement throws", () => {
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
