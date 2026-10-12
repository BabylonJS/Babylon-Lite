import { describe, expect, it } from "vitest";
import { resolveTrogirQuality } from "../../../lab/lite/src/demos/trogir-quality";
import { getSplatStreamGpuCapacity } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu";

describe("Trogir allocation tiers", () => {
    it.each(["", "?quality=low", "?quality=unknown"])("defaults to allocations that fit a 128 MiB storage binding: %s", (query) => {
        const tier = resolveTrogirQuality("https://example.test/demo.html" + query);
        const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxComputeWorkgroupsPerDimension: 65535 } } as GPUDevice;
        expect(tier.name).toBe("low");
        expect(tier.streamOptions.maxSplats).toBe(1_000_000);
        expect(tier.streamOptions.maxCpuBytes).toBe(64 * 1024 * 1024);
        expect(tier.requiredLimits.maxStorageBufferBindingSize).toBeLessThanOrEqual(device.limits.maxStorageBufferBindingSize);
        expect(getSplatStreamGpuCapacity(device, tier.streamOptions.maxCapacitySplats, tier.streamOptions.maxGpuBytes)).toBe(tier.streamOptions.maxCapacitySplats);
    });

    it("keeps high detail opt-in and sizes both tiers' limits and budgets for their immutable capacity", () => {
        const low = resolveTrogirQuality("https://example.test/demo.html");
        const high = resolveTrogirQuality("https://example.test/demo.html?quality=high");
        expect(high.streamOptions.maxSplats).toBe(4_000_000);
        expect(low.streamOptions.maxCapacitySplats).toBeLessThan(high.streamOptions.maxCapacitySplats);
        expect(low.streamOptions.maxGpuBytes).toBeLessThan(high.streamOptions.maxGpuBytes);
        expect(low.streamOptions.maxCpuBytes).toBeLessThan(high.streamOptions.maxCpuBytes);
        for (const tier of [low, high]) {
            const options = tier.streamOptions;
            expect(options.maxCapacitySplats - options.maxSplats).toBeGreaterThanOrEqual(9237);
            expect(tier.requiredLimits.maxBufferSize).toBe(options.maxCapacitySplats * 64);
            expect(tier.requiredLimits.maxStorageBufferBindingSize).toBe(options.maxCapacitySplats * 64);
            const device = { limits: { ...tier.requiredLimits, maxComputeWorkgroupsPerDimension: 65535 } } as GPUDevice;
            expect(getSplatStreamGpuCapacity(device, options.maxCapacitySplats, options.maxGpuBytes)).toBe(options.maxCapacitySplats);
        }
    });
});
