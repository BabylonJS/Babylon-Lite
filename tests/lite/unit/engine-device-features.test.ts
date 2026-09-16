import { describe, expect, it } from "vitest";

import { _getSupportedDeviceFeatures } from "../../../packages/babylon-lite/src/engine/engine.js";

describe("engine optional device features", () => {
    it("requests unaligned compressed-texture support when the adapter offers it", () => {
        const adapter = {
            features: new Set<GPUFeatureName>(["texture-compression-bc", "texture-compression-unaligned" as GPUFeatureName, "timestamp-query"]),
        } as unknown as GPUAdapter;

        expect(_getSupportedDeviceFeatures(adapter)).toEqual(["texture-compression-bc", "texture-compression-unaligned", "timestamp-query"]);
    });

    it("does not request unsupported optional features", () => {
        const adapter = { features: new Set<GPUFeatureName>() } as unknown as GPUAdapter;

        expect(_getSupportedDeviceFeatures(adapter)).toEqual([]);
    });
});
