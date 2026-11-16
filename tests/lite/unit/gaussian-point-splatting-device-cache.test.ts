import { afterEach, describe, expect, it, vi } from "vitest";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { disableGaussianPointSplatting, enableGaussianPointSplatting } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gaussian-point-splatting.js";
import { gpsRecordReprojection } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-reproject.js";
import type { GpsReprojectionTarget } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-reproject.js";
import type { GaussianSplatStream } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { installTrogirPointSurfaceLimit } from "../../../lab/lite/src/demos/trogir-point-surface";
import { resolveTrogirQuality } from "../../../lab/lite/src/demos/trogir-quality";

vi.mock("../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu.js", () => ({
    getSplatStreamDrawBatch: () => ({ reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() }),
}));

function fixture(bufferLimit = 64_640_000) {
    const device = {
        limits: { maxBufferSize: bufferLimit, maxStorageBufferBindingSize: bufferLimit },
        queue: { writeBuffer: vi.fn() },
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            if (descriptor.size > bufferLimit) {
                throw new RangeError("Buffer exceeds granted limit");
            }
            return { destroy: vi.fn() };
        }),
        createShaderModule: vi.fn(() => ({})),
        createBindGroupLayout: vi.fn(() => ({})),
        createBindGroup: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createComputePipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
        createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
    } as unknown as GPUDevice;
    const encoder = {
        beginComputePass: vi.fn(() => ({
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            dispatchWorkgroups: vi.fn(),
            dispatchWorkgroupsIndirect: vi.fn(),
            end: vi.fn(),
        })),
        copyBufferToBuffer: vi.fn(),
        clearBuffer: vi.fn(),
    } as unknown as GPUCommandEncoder;
    const canvas = { clientWidth: 16, clientHeight: 16, width: 16, height: 16 } as HTMLCanvasElement;
    const engine = {
        _device: device,
        _currentEncoder: encoder,
        canvas,
        maxDevicePixelRatio: Infinity,
        scRT: {},
        _renderingContexts: [],
    } as unknown as EngineContext;
    const scene = {
        surface: engine,
        _renderables: [],
        _renderableVersion: 0,
        _beforeRender: [],
        _disposables: [],
        _built: true,
    } as unknown as SceneContext;
    Object.assign(engine, { engine });
    const stream = {
        _engine: engine,
        _disposed: false,
        _renderable: null,
        _gpu: { count: 1, contentGeneration: 0, gatheredGeneration: 0, canonical: {}, intervals: [] },
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        boundMin: [-1, -1, -1],
        boundMax: [1, 1, 1],
    } as unknown as GaussianSplatStream;
    const gps = enableGaussianPointSplatting(scene, stream, { renderScale: 1, maxAccumFrames: 1 });
    const signature = { _colorFormat: "bgra8unorm", _sampleCount: 1 } as RenderTargetSignature;
    const renderable = scene._renderables[0]!;
    const binding = renderable.bind(engine, signature);
    const batch = binding._updateBatches![1]!;
    const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() } as unknown as GPURenderPassEncoder;
    return {
        device,
        encoder,
        engine,
        canvas,
        gps,
        signature,
        frame() {
            batch.reset();
            binding.update!({ targetWidth: canvas.width, targetHeight: canvas.height, _camera: camera });
            batch.flush(engine);
            binding.draw(pass, engine);
        },
        bind() {
            return renderable.bind(engine, signature);
        },
        dispose() {
            disableGaussianPointSplatting(scene, gps);
            engine._retirements?.splice(0).forEach((destroy) => destroy());
        },
    };
}

afterEach(() => vi.unstubAllGlobals());

describe("Gaussian point splatting device isolation", () => {
    it("retains compute and composite pipelines and bind groups when alternating two converged engines", () => {
        const engines = [fixture(), fixture()];
        for (const current of engines) {
            current.frame();
        }
        const warm = engines.map(({ device }) => ({
            compute: vi.mocked(device.createComputePipeline).mock.calls.length,
            render: vi.mocked(device.createRenderPipeline).mock.calls.length,
            shader: vi.mocked(device.createShaderModule).mock.calls.length,
            groups: vi.mocked(device.createBindGroup).mock.calls.length,
        }));
        for (let frame = 0; frame < 4; frame++) {
            for (const current of engines) {
                current.bind();
                current.frame();
            }
        }
        engines.forEach(({ device, gps, dispose }, i) => {
            expect(device.createComputePipeline).toHaveBeenCalledTimes(warm[i]!.compute);
            expect(device.createRenderPipeline).toHaveBeenCalledTimes(warm[i]!.render);
            expect(device.createShaderModule).toHaveBeenCalledTimes(warm[i]!.shader);
            expect(device.createBindGroup).toHaveBeenCalledTimes(warm[i]!.groups);
            expect(gps.progress?.accumulatedSamples).toBe(1);
            dispose();
        });
    });

    it("retains all three reprojection pipelines independently for alternating devices", () => {
        const engines = [fixture(), fixture()];
        const targets = engines.map(() => ({ accum: {}, depth: {}, counts: {}, buffers: [] }) as unknown as GpsReprojectionTarget);
        const params = new Float32Array(52);
        params.set([16, 16, 1, 16], 48);
        const dispatches = engines.map(() => vi.fn());
        const record = (index: number): void => {
            const { device, encoder } = engines[index]!;
            gpsRecordReprojection(
                device,
                encoder,
                targets[index]!,
                params,
                (size, label) => device.createBuffer({ size, label, usage: GPUBufferUsage.STORAGE }),
                dispatches[index]!
            );
        };
        engines.forEach((_, index) => record(index));
        const warm = engines.map(({ device }) => vi.mocked(device.createComputePipeline).mock.calls.length);
        for (let frame = 0; frame < 4; frame++) {
            engines.forEach((_, index) => record(index));
        }
        engines.forEach(({ device, dispose }, index) => {
            expect(device.createComputePipeline).toHaveBeenCalledTimes(warm[index]!);
            const calls = dispatches[index]!.mock.calls;
            expect(calls).toHaveLength(15);
            for (let call = 3; call < calls.length; call++) {
                expect(calls[call]![0]).toBe(calls[call % 3]![0]);
            }
            targets[index]!.buffers.forEach((buffer) => buffer.destroy());
            dispose();
        });
        expect(dispatches[0]!.mock.calls[0]![0]).not.toBe(dispatches[1]!.mock.calls[0]![0]);
    });

    it("bounds high-DPI accumulation and history to the low-tier granted limits across resize and display changes", () => {
        const quality = resolveTrogirQuality("https://example.test/demo.html");
        const limit = Math.min(quality.requiredLimits.maxBufferSize, quality.requiredLimits.maxStorageBufferBindingSize);
        const current = fixture(limit);
        const page = new EventTarget();
        const resolutions: EventTarget[] = [];
        vi.stubGlobal(
            "window",
            Object.assign(page, {
                matchMedia: vi.fn(() => {
                    const query = new EventTarget();
                    resolutions.push(query);
                    return query;
                }),
            })
        );
        let layoutChanged: () => void = () => {};
        const disconnect = vi.fn();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(callback: () => void) {
                    layoutChanged = callback;
                }
                observe = vi.fn();
                disconnect = disconnect;
            }
        );
        vi.stubGlobal("devicePixelRatio", 2);
        Object.assign(current.canvas, { clientWidth: 1280, clientHeight: 800, width: 2560, height: 1600 });
        expect(current.canvas.width * current.canvas.height * 16).toBeGreaterThan(limit);
        const disposeLimit = installTrogirPointSurfaceLimit(current.engine, current.canvas, limit);
        const assertSupported = (): void => {
            expect(current.canvas.width * current.canvas.height * 16).toBeLessThanOrEqual(limit);
            expect(() => current.frame()).not.toThrow();
            const pixelCount = current.canvas.width * current.canvas.height;
            const target = {
                accum: current.device.createBuffer({ size: pixelCount * 16, usage: GPUBufferUsage.STORAGE }),
                depth: current.device.createBuffer({ size: pixelCount * 4, usage: GPUBufferUsage.STORAGE }),
                counts: current.device.createBuffer({ size: pixelCount * 4, usage: GPUBufferUsage.STORAGE }),
                buffers: [],
            } as GpsReprojectionTarget;
            const params = new Float32Array(52);
            params.set([current.canvas.width, current.canvas.height, 1, 16], 48);
            expect(() =>
                gpsRecordReprojection(current.device, current.encoder, target, params, (size) => current.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE }), vi.fn())
            ).not.toThrow();
            target.buffers.forEach((buffer) => buffer.destroy());
        };
        assertSupported();
        Object.assign(current.canvas, { clientWidth: 3840, clientHeight: 2160 });
        layoutChanged();
        assertSupported();
        Object.assign(current.canvas, { clientWidth: 800, clientHeight: 600 });
        page.dispatchEvent(new Event("resize"));
        expect(current.canvas.width).toBe(1600);
        vi.stubGlobal("devicePixelRatio", 3);
        resolutions[0]!.dispatchEvent(new Event("change"));
        expect(current.canvas.width).toBeGreaterThan(1600);
        expect(current.canvas.width).toBeLessThan(2400);
        assertSupported();
        const size = [current.canvas.width, current.canvas.height];
        disposeLimit();
        Object.assign(current.canvas, { clientWidth: 10000, clientHeight: 10000 });
        page.dispatchEvent(new Event("resize"));
        layoutChanged();
        expect([current.canvas.width, current.canvas.height]).toEqual(size);
        expect(disconnect).toHaveBeenCalledOnce();
        current.dispose();
    });
});
