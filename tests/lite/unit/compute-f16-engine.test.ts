import { afterEach, describe, expect, it, vi } from "vitest";

import { isComputeF16Supported } from "../../../packages/babylon-lite/src/compute/compute-uniform-f16";
import { createEngine, disposeEngine, type EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("compute f16 engine opt-in", () => {
    it("reports adapter capability before engine creation and enabled support afterward", async () => {
        vi.stubGlobal("navigator", {
            gpu: {
                requestAdapter: vi.fn(async () => ({
                    features: new Set<GPUFeatureName>(["shader-f16"]),
                })),
            },
        });

        expect(await isComputeF16Supported()).toBe(true);
        const unsupported = {} as EngineContext;
        const unsupportedDevice = {} as GPUDevice;
        Object.defineProperty(unsupportedDevice, "features", { value: new Set<GPUFeatureName>() });
        unsupported._device = unsupportedDevice;
        const supported = {} as EngineContext;
        const supportedDevice = {} as GPUDevice;
        Object.defineProperty(supportedDevice, "features", { value: new Set<GPUFeatureName>(["shader-f16"]) });
        supported._device = supportedDevice;
        expect(isComputeF16Supported(unsupported)).toBe(false);
        expect(isComputeF16Supported(supported)).toBe(true);
    });

    it("requests explicitly required WebGPU features and rejects unsupported ones", async () => {
        const requestDevice = vi.fn(async () => device);
        const adapter = {
            features: new Set<GPUFeatureName>(["texture-formats-tier1"]),
            requestDevice,
        };
        const texture = {
            width: 4,
            height: 4,
            createView: vi.fn(() => ({})),
        };
        const context = {
            configure: vi.fn(),
            unconfigure: vi.fn(),
            getCurrentTexture: vi.fn(() => texture),
        };
        const device = {
            features: new Set<GPUFeatureName>(["texture-formats-tier1"]),
            destroy: vi.fn(),
        } as unknown as GPUDevice;
        const canvas = {
            width: 4,
            height: 4,
            getContext: vi.fn(() => context),
        } as unknown as OffscreenCanvas;
        vi.stubGlobal("navigator", {
            gpu: {
                requestAdapter: vi.fn(async () => adapter),
                getPreferredCanvasFormat: vi.fn(() => "bgra8unorm"),
            },
        });

        const engine = await createEngine(canvas, { requiredFeatures: ["texture-formats-tier1"] });
        expect(requestDevice).toHaveBeenCalledWith(expect.objectContaining({ requiredFeatures: ["texture-formats-tier1"] }));
        disposeEngine(engine);

        await expect(createEngine(canvas, { requiredFeatures: ["bgra8unorm-storage"] })).rejects.toThrow(/bgra8unorm-storage/);
    });

    it("rejects engine creation when the adapter lacks required shader-f16", async () => {
        vi.stubGlobal("navigator", {
            gpu: {
                requestAdapter: vi.fn(async () => ({
                    features: new Set<GPUFeatureName>(),
                    requestDevice: vi.fn(),
                })),
            },
        });

        await expect(createEngine({} as OffscreenCanvas, { requiredFeatures: ["shader-f16"] })).rejects.toThrow(/shader-f16/);
    });

    it("requests shader-f16 only through per-engine required features", async () => {
        const requestDevice = vi.fn(async () => device);
        const adapter = {
            features: new Set<GPUFeatureName>(["shader-f16"]),
            requestDevice,
        };
        const texture = {
            width: 4,
            height: 4,
            createView: vi.fn(() => ({})),
        };
        const context = {
            configure: vi.fn(),
            unconfigure: vi.fn(),
            getCurrentTexture: vi.fn(() => texture),
        };
        const device = {
            features: new Set<GPUFeatureName>(["shader-f16"]),
            destroy: vi.fn(),
        } as unknown as GPUDevice;
        const canvas = {
            width: 4,
            height: 4,
            getContext: vi.fn(() => context),
        } as unknown as OffscreenCanvas;
        vi.stubGlobal("navigator", {
            gpu: {
                requestAdapter: vi.fn(async () => adapter),
                getPreferredCanvasFormat: vi.fn(() => "bgra8unorm"),
            },
        });

        const engine = await createEngine(canvas, { requiredFeatures: ["shader-f16"] });

        expect(requestDevice).toHaveBeenCalledWith(expect.objectContaining({ requiredFeatures: ["shader-f16"] }));
        const regularEngine = await createEngine(canvas);
        expect(requestDevice).toHaveBeenNthCalledWith(2, expect.objectContaining({ requiredFeatures: [] }));
        disposeEngine(engine);
        disposeEngine(regularEngine);
        expect(device.destroy).toHaveBeenCalledTimes(2);
    });
});
