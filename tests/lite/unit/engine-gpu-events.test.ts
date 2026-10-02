import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { getEngineLimits, hasEngineFeature, onEngineDeviceLost, onEngineGpuError } from "../../../packages/babylon-lite/src/engine/engine-gpu-events";
import { enableDeviceLostSpriteRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-sprite-recovery";
import { runDeviceLostRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-recovery-run";

interface FakeDevice extends GPUDevice {
    emitError(error: GPUError): void;
    loseDevice(info: GPUDeviceLostInfo): void;
    listenerCount(): number;
}

function makeDevice(features: GPUFeatureName[] = []): FakeDevice {
    const target = new EventTarget();
    let listeners = 0;
    let lose!: (info: GPUDeviceLostInfo) => void;
    const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
        lose = resolve;
    });
    return {
        features: new Set<GPUFeatureName>(features),
        limits: { maxTextureArrayLayers: 256, minUniformBufferOffsetAlignment: 256 } as GPUSupportedLimits,
        lost,
        addEventListener: (type: string, listener: EventListener) => {
            listeners++;
            target.addEventListener(type, listener);
        },
        removeEventListener: (type: string, listener: EventListener) => {
            listeners--;
            target.removeEventListener(type, listener);
        },
        emitError(error: GPUError) {
            target.dispatchEvent(Object.assign(new Event("uncapturederror"), { error }));
        },
        loseDevice(info: GPUDeviceLostInfo) {
            lose(info);
        },
        listenerCount: () => listeners,
    } as unknown as FakeDevice;
}

function makeEngine(device = makeDevice()): EngineContext {
    return { _device: device, surfaces: [], _animFrameId: 0, _renderFn: null, _retirements: null } as unknown as EngineContext;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("engine GPU events", () => {
    it("forwards uncaptured errors to every subscriber until it unsubscribes", () => {
        const device = makeDevice();
        const engine = makeEngine(device);
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = onEngineGpuError(engine, first);
        onEngineGpuError(engine, second);
        const error = { message: "invalid pipeline" } as GPUError;

        device.emitError(error);
        stopFirst();
        device.emitError(error);

        expect(first).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledWith(error);
        expect(second).toHaveBeenCalledTimes(2);
        expect(device.listenerCount()).toBe(1);
    });

    it("reports the loss of the current device with its reason", async () => {
        const device = makeDevice();
        const engine = makeEngine(device);
        const lost = vi.fn();
        onEngineDeviceLost(engine, lost);
        const info = { reason: "unknown", message: "GPU process crashed" } as GPUDeviceLostInfo;

        device.loseDevice(info);
        await flush();

        expect(lost).toHaveBeenCalledWith(info);
    });

    it("follows the replacement device that device-lost recovery installs", async () => {
        const lostDevice = makeDevice();
        const replacement = makeDevice();
        const engine = makeEngine(lostDevice);
        const recovery = enableDeviceLostSpriteRecovery(engine);
        const errors = vi.fn();
        const lost = vi.fn();
        onEngineGpuError(engine, errors);
        onEngineDeviceLost(engine, lost);
        vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => ({ features: new Set<GPUFeatureName>(), requestDevice: vi.fn(async () => replacement) })) } });

        await runDeviceLostRecovery(engine, engine._deviceLostRecovery!, []);
        const error = { message: "after recovery" } as GPUError;
        replacement.emitError(error);
        lostDevice.emitError({ message: "stale device" } as GPUError);
        replacement.loseDevice({ reason: "unknown", message: "second loss" } as GPUDeviceLostInfo);
        await flush();

        expect(errors.mock.calls).toEqual([[error]]);
        expect(lostDevice.listenerCount()).toBe(0);
        expect(lost).toHaveBeenCalledWith(expect.objectContaining({ message: "second loss" }));
        recovery.disable();
    });

    it("exposes limits and features as read-only information", () => {
        const engine = makeEngine(makeDevice(["timestamp-query"]));

        expect(getEngineLimits(engine).maxTextureArrayLayers).toBe(256);
        expect(hasEngineFeature(engine, "timestamp-query")).toBe(true);
        expect(hasEngineFeature(engine, "shader-f16")).toBe(false);
    });
});
