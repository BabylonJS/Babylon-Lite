const MB = 1024 * 1024;

/** Select before device creation: the slider cannot resize the stream's fixed working buffers. */
export function resolveTrogirQuality(pageUrl: string) {
    const high = new URL(pageUrl).searchParams.get("quality") === "high";
    const maxSplats = high ? 4_000_000 : 1_000_000;
    const maxCapacitySplats = maxSplats + 10_000;
    return {
        name: high ? "high" : "low",
        streamOptions: {
            maxSplats,
            maxCapacitySplats,
            maxGpuBytes: (high ? 1024 : 256) * MB,
            maxCpuBytes: (high ? 192 : 64) * MB,
        },
        requiredLimits: {
            maxBufferSize: maxCapacitySplats * 64,
            maxStorageBufferBindingSize: maxCapacitySplats * 64,
        },
    };
}
