import { describe, expect, it } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { measureRenderTaskOverdrawCost } from "../../../packages/babylon-lite/src/engine/gpu-task-timing";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { DrawBinding } from "../../../packages/babylon-lite/src/render/renderable";

const gpuGlobals = globalThis as typeof globalThis & {
    GPUBufferUsage?: typeof GPUBufferUsage;
    GPUMapMode?: typeof GPUMapMode;
    GPUTextureUsage?: typeof GPUTextureUsage;
};
gpuGlobals.GPUBufferUsage ??= { COPY_DST: 0x8, COPY_SRC: 0x4, MAP_READ: 0x1, QUERY_RESOLVE: 0x200 } as typeof GPUBufferUsage;
gpuGlobals.GPUMapMode ??= { READ: 0x1, WRITE: 0x2 } as typeof GPUMapMode;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10 } as typeof GPUTextureUsage;

function makeBinding(name: string, z: number, drawOrders: Map<string, string[]>, visible = true): DrawBinding {
    return {
        renderable: {
            order: 0,
            isTransparent: false,
            mesh: { visible },
            _worldCenter: [0, 0, z],
        },
        pipeline: { label: name },
        draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
            const label = (pass as unknown as { _label: string })._label;
            drawOrders.get(label)!.push(name);
            return 1;
        },
    } as unknown as DrawBinding;
}

describe("render-task overdraw probe", () => {
    it("rejects unsupported devices and invalid repeat counts before allocating GPU resources", async () => {
        const unsupported = { _device: { features: new Set<GPUFeatureName>() } } as unknown as EngineContext;
        await expect(measureRenderTaskOverdrawCost(unsupported, {} as RenderTask)).rejects.toThrow("timestamp-query");

        const supported = { _device: { features: new Set<GPUFeatureName>(["timestamp-query"]) } } as unknown as EngineContext;
        await expect(measureRenderTaskOverdrawCost(supported, {} as RenderTask, { repeats: 0 })).rejects.toThrow("positive integer");
        await expect(measureRenderTaskOverdrawCost(supported, {} as RenderTask, { repeats: 1.5 })).rejects.toThrow("positive integer");
    });

    it("rejects tasks whose shipped pass loads existing depth", async () => {
        const engine = { _device: { features: new Set<GPUFeatureName>(["timestamp-query"]) } } as unknown as EngineContext;
        const colorTarget = {
            _descriptor: { format: "rgba8unorm", samples: 1, size: { width: 64, height: 32 } },
        } as RenderTarget;
        const loadedTargetTask = {
            _config: { rt: colorTarget, depthClear: false },
        } as unknown as RenderTask;
        const eagerDepthTask = {
            _config: {
                rt: colorTarget,
                depth: { _eager: true, _descriptor: { dFormat: "depth32float", samples: 1, size: { width: 64, height: 32 } } },
            },
        } as unknown as RenderTask;

        await expect(measureRenderTaskOverdrawCost(engine, loadedTargetTask, { repeats: 1 })).rejects.toThrow("load existing depth");
        await expect(measureRenderTaskOverdrawCost(engine, eagerDepthTask, { repeats: 1 })).rejects.toThrow("load existing depth");
    });

    it("uses the task depth clear convention, skips invisible bindings, and preserves transparent order", async () => {
        const drawOrders = new Map([
            ["overdraw-probe-a", [] as string[]],
            ["overdraw-probe-b", [] as string[]],
            ["overdraw-probe-c", [] as string[]],
        ]);
        const renderPassDescriptors: GPURenderPassDescriptor[] = [];
        const destroyed: string[] = [];
        const timestamps = new BigUint64Array([0n, 5_000_000n, 10_000_000n, 12_000_000n, 20_000_000n, 23_000_000n]);
        const resolveBuffer = { destroy: () => destroyed.push("resolve") } as unknown as GPUBuffer;
        const readBuffer = {
            mapAsync: () => Promise.resolve(),
            getMappedRange: () => timestamps.buffer,
            unmap: () => undefined,
            destroy: () => destroyed.push("read"),
        } as unknown as GPUBuffer;
        let bufferIndex = 0;

        const device = {
            features: new Set<GPUFeatureName>(["timestamp-query"]),
            createTexture(descriptor: GPUTextureDescriptor) {
                const label = descriptor.label as string;
                return {
                    createView: () => ({ label: `${label}-view` }),
                    destroy: () => destroyed.push(label),
                } as unknown as GPUTexture;
            },
            createQuerySet: () => ({ destroy: () => destroyed.push("queries") }) as unknown as GPUQuerySet,
            createBuffer: () => (bufferIndex++ === 0 ? resolveBuffer : readBuffer),
            createCommandEncoder: () =>
                ({
                    beginRenderPass(descriptor: GPURenderPassDescriptor) {
                        renderPassDescriptors.push(descriptor);
                        const label = descriptor.label as string;
                        return {
                            _label: label,
                            setViewport: () => undefined,
                            setScissorRect: () => undefined,
                            setBindGroup: () => undefined,
                            setPipeline: () => undefined,
                            end: () => undefined,
                        } as unknown as GPURenderPassEncoder;
                    },
                    resolveQuerySet: () => undefined,
                    copyBufferToBuffer: () => undefined,
                    finish: () => ({}) as GPUCommandBuffer,
                }) as unknown as GPUCommandEncoder,
            queue: { submit: () => undefined },
        } as unknown as GPUDevice;
        const camera = {
            worldMatrixVersion: 1,
            _viewVer: 1,
            _viewCache: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        } as unknown as Camera;
        const colorTarget = {
            _descriptor: { format: "rgba8unorm", samples: 1, size: { width: 64, height: 32 } },
            _width: 64,
            _height: 32,
        } as RenderTarget;
        const depthTarget = {
            _descriptor: { dFormat: "depth32float", _depthClearValue: 1, samples: 1, size: { width: 64, height: 32 } },
        } as RenderTarget;
        const far = makeBinding("far", 5, drawOrders);
        const hidden = makeBinding("hidden", 4, drawOrders, false);
        const near = makeBinding("near", 1, drawOrders);
        const direct = makeBinding("direct", 3, drawOrders);
        const transparent = makeBinding("transparent", 9, drawOrders);
        const task = {
            _config: { rt: colorTarget, depth: depthTarget, cam: camera },
            _targetSignature: { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 },
            _opaqueBindings: [far, hidden, near],
            _directBindings: [direct],
            _transparentBindings: [transparent],
            _sceneBG: {},
            scene: { camera: null },
        } as unknown as RenderTask;

        const result = await measureRenderTaskOverdrawCost({ _device: device } as unknown as EngineContext, task, { repeats: 1 });

        expect(result).toEqual({
            width: 64,
            height: 32,
            sampleCount: 1,
            bindings: 4,
            msAsIs: 5,
            msVisibleOnly: 2,
            overdrawMs: 3,
            ratio: 2.5,
            msFrontToBack: 3,
            sortGainMs: 2,
            repeats: 1,
        });
        expect(drawOrders.get("overdraw-probe-a")).toEqual(["far", "near", "direct", "transparent"]);
        expect(drawOrders.get("overdraw-probe-b")).toEqual(["far", "near", "direct", "transparent"]);
        expect(drawOrders.get("overdraw-probe-c")).toEqual(["near", "direct", "far", "transparent"]);
        expect(renderPassDescriptors[0]!.depthStencilAttachment).toMatchObject({ depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" });
        expect(renderPassDescriptors[1]!.depthStencilAttachment).toMatchObject({ depthLoadOp: "load", depthStoreOp: "discard" });
        expect(renderPassDescriptors[2]!.depthStencilAttachment).toMatchObject({ depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" });
        expect(destroyed).toEqual(["queries", "resolve", "read", "overdraw-probe-color", "overdraw-probe-depth"]);
    });
});
