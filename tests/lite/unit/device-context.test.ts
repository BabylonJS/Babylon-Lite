import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevice, _installAdapterOptions, type DeviceOptions } from "../../../packages/babylon-lite/src/engine/device.js";
import { disposeDevice } from "../../../packages/babylon-lite/src/engine/device-dispose.js";
import { createEngine } from "../../../packages/babylon-lite/src/engine/engine.js";
import { disposeEngine } from "../../../packages/babylon-lite/src/engine/engine-dispose.js";
import { _enableDeviceLostRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import { _resetMatrixAllocatorForTests } from "../../../packages/babylon-lite/src/math/_matrix-allocator.js";

function nativeDevice(features: GPUFeatureName[] = []) {
    let lose!: (info: GPUDeviceLostInfo) => void;
    const destroy = vi.fn();
    const device = {
        features: new Set(features),
        limits: { maxBufferSize: 1024 },
        lost: new Promise<GPUDeviceLostInfo>((resolve) => {
            lose = resolve;
        }),
        destroy,
        createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })),
        createSampler: vi.fn(() => ({})),
        queue: {
            onSubmittedWorkDone: vi.fn(async () => undefined),
            copyExternalImageToTexture: vi.fn(),
            writeTexture: vi.fn(),
        },
    } as unknown as GPUDevice;
    return { device, destroy, lose };
}

function gpu(features: GPUFeatureName[] = []) {
    const native = nativeDevice(features);
    const adapterFeatures = new Set(features);
    const requestDevice = vi.fn(async (descriptor: GPUDeviceDescriptor) => {
        const missing = [...(descriptor.requiredFeatures ?? [])].find((feature) => !adapterFeatures.has(feature));
        if (missing) {
            throw new TypeError(`Unsupported feature: ${missing}`);
        }
        // Like WebGPU, the device reports requested limits and defaults for the rest.
        Object.assign(native.device.limits, descriptor.requiredLimits);
        return native.device;
    });
    const adapter = { features: adapterFeatures, requestDevice };
    const requestAdapter = vi.fn(async (_options: GPURequestAdapterOptions): Promise<typeof adapter | null> => adapter);
    vi.stubGlobal("navigator", { gpu: { requestAdapter, getPreferredCanvasFormat: () => "bgra8unorm" } });
    return { ...native, requestAdapter, requestDevice };
}

function lossInfo(): GPUDeviceLostInfo {
    return { reason: "unknown", message: "" } as GPUDeviceLostInfo;
}

function canvas() {
    const context = {
        configure: vi.fn(),
        unconfigure: vi.fn(),
        getCurrentTexture: vi.fn(() => ({ width: 4, height: 4, createView: () => ({}) })),
    };
    const element = { width: 4, height: 4, getContext: vi.fn(() => context) } as unknown as OffscreenCanvas;
    return { element, context };
}

afterEach(() => {
    _resetMatrixAllocatorForTests();
    _installAdapterOptions(() => ({}));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("device acquisition", () => {
    it("acquires without touching a canvas and retains its creation options", async () => {
        const mock = gpu(["timestamp-query", "shader-f16"]);
        const options: DeviceOptions = { requiredLimits: { maxBufferSize: 1024 } };
        const context = await createDevice(options);
        expect(mock.requestAdapter).toHaveBeenCalledExactlyOnceWith({ powerPreference: "high-performance" });
        expect(mock.requestDevice).toHaveBeenCalledExactlyOnceWith({ requiredFeatures: ["timestamp-query"], requiredLimits: { maxBufferSize: 1024 } });
        expect(context._device).toBe(mock.device);
        expect(context._options).toBe(options);
        disposeDevice(context);
        disposeDevice(context);
        expect(mock.destroy).toHaveBeenCalledOnce();
    });

    it("requests only supported optional features by default and applies installed adapter options", async () => {
        const mock = gpu(["timestamp-query", "shader-f16"]);
        _installAdapterOptions(() => ({ forceFallbackAdapter: true }));
        const context = await createDevice({ requiredLimits: { maxBufferSize: 4096 } });
        expect(mock.requestAdapter).toHaveBeenCalledExactlyOnceWith({ powerPreference: "high-performance", forceFallbackAdapter: true });
        expect(mock.requestDevice).toHaveBeenCalledExactlyOnceWith({ requiredFeatures: ["timestamp-query"], requiredLimits: { maxBufferSize: 4096 } });
        disposeDevice(context);
    });

    it("reports missing adapters and propagates adapter/device request failures", async () => {
        const mock = gpu();
        mock.requestAdapter.mockResolvedValueOnce(null);
        await expect(createDevice()).rejects.toThrow("WebGPU adapter not available");
        mock.requestAdapter.mockRejectedValueOnce(new Error("adapter failed"));
        await expect(createDevice()).rejects.toThrow("adapter failed");
        mock.requestDevice.mockRejectedValueOnce(new Error("device failed"));
        await expect(createDevice()).rejects.toThrow("device failed");
    });
});

describe("engine device ownership", () => {
    it("takes ownership of a created device and destroys it with the engine", async () => {
        const mock = gpu();
        const device = await createDevice();
        const target = canvas();
        const engine = await createEngine(target.element, { device, msaaSamples: 1 });
        expect(engine.device).toBe(device);
        expect(engine._device).toBe(mock.device);
        expect(mock.requestAdapter).toHaveBeenCalledOnce();
        disposeDevice(device);
        expect(mock.destroy).not.toHaveBeenCalled();
        disposeEngine(engine);
        expect(target.context.unconfigure).toHaveBeenCalledOnce();
        expect(mock.destroy).toHaveBeenCalledOnce();
    });

    it("creates and owns a device when none is supplied", async () => {
        const mock = gpu();
        const options = { requiredLimits: { maxBufferSize: 2048 } };
        const engine = await createEngine(canvas().element, options);
        expect(engine.device._device).toBe(mock.device);
        expect(engine.device._options).toBe(options);
        expect(mock.requestDevice).toHaveBeenCalledExactlyOnceWith({ requiredFeatures: [], requiredLimits: { maxBufferSize: 2048 } });
        disposeEngine(engine);
        expect(mock.destroy).toHaveBeenCalledOnce();
    });

    it("rejects a device that already backs an engine or was disposed, before configuring the canvas", async () => {
        gpu();
        const device = await createDevice();
        const engine = await createEngine(canvas().element, { device });
        const second = canvas();
        await expect(createEngine(second.element, { device })).rejects.toThrow(/only one engine/);
        expect(second.context.configure).not.toHaveBeenCalled();
        disposeEngine(engine);

        const unused = await createDevice();
        disposeDevice(unused);
        const third = canvas();
        await expect(createEngine(third.element, { device: unused })).rejects.toThrow(/disposeDevice/);
        expect(third.context.configure).not.toHaveBeenCalled();
    });

    it("rejects conflicting acquisition option types and invalid precision", async () => {
        const mock = gpu();
        const device = await createDevice();
        // Acquisition options belong to createDevice; the overload rejects them at compile time.
        const typeOnly = () => {
            // @ts-expect-error Limits must be configured on createDevice.
            void createEngine(canvas().element, { device, requiredLimits: { maxBufferSize: 1024 } });
            // @ts-expect-error Explicit features require createEngineWithFeatures.
            void createEngine(canvas().element, { device, requiredFeatures: ["shader-f16"] });
        };
        void typeOnly;
        await expect(createEngine(canvas().element, { useFloatingOrigin: true })).rejects.toThrow(/useHighPrecisionMatrix/);
        expect(mock.requestAdapter).toHaveBeenCalledOnce();
        disposeDevice(device);
    });
});

describe("device recovery", () => {
    it("recreates the device with its creation options and updates the device context", async () => {
        const mock = gpu(["timestamp-query"]);
        const device = await createDevice({ requiredLimits: { maxBufferSize: 2048 } });
        const engine = await createEngine(canvas().element, { device });
        const replacement = nativeDevice(["timestamp-query"]);
        mock.requestDevice.mockResolvedValue(replacement.device);
        const recovered = new Promise<void>((resolve) => {
            _enableDeviceLostRecovery(engine, { _kind: "test", _recover: vi.fn(), _onRecovered: resolve });
        });
        mock.lose(lossInfo());
        await recovered;
        expect(mock.requestAdapter).toHaveBeenLastCalledWith({ powerPreference: "high-performance" });
        expect(mock.requestDevice).toHaveBeenLastCalledWith({ requiredFeatures: ["timestamp-query"], requiredLimits: { maxBufferSize: 2048 } });
        expect(engine._device).toBe(replacement.device);
        expect(device._device).toBe(replacement.device);
        disposeEngine(engine);
        expect(replacement.destroy).toHaveBeenCalledOnce();
    });
});
