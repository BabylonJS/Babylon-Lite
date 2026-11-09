import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevice } from "../../../packages/babylon-lite/src/engine/device.js";

async function requestedFeatures(adapterFeatures: GPUFeatureName[]): Promise<Iterable<GPUFeatureName> | undefined> {
    const requestDevice = vi.fn(async (_descriptor: GPUDeviceDescriptor) => ({}) as GPUDevice);
    const adapter = { features: new Set(adapterFeatures), requestDevice };
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => adapter } });
    await createDevice();
    return requestDevice.mock.calls[0]?.[0].requiredFeatures;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("engine optional device features", () => {
    it("requests unaligned compressed-texture support when the adapter offers it", async () => {
        const features = ["texture-compression-bc", "texture-compression-unaligned" as GPUFeatureName, "timestamp-query"] as GPUFeatureName[];

        expect(await requestedFeatures(features)).toEqual(["texture-compression-bc", "texture-compression-unaligned", "timestamp-query"]);
    });

    it("does not request unsupported optional features", async () => {
        expect(await requestedFeatures([])).toEqual([]);
    });
});
