import { describe, expect, it, vi } from "vitest";

import {
    admitSplatSource,
    canReserveSplatSourceGpuBytes,
    createSplatSourceCache,
    disposeSplatSourceCache,
    evictSplatSource,
    reserveSplatSourceGpuBytes,
    setSplatSourceProtection,
    type SplatSourceCacheEntry,
} from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-cache";

function entry(url: string, gpuBytes: number, cpuBytes: number, frame: number): SplatSourceCacheEntry & { destroyed: ReturnType<typeof vi.fn>[] } {
    const destroyed = Array.from({ length: 6 }, () => vi.fn());
    return {
        url,
        generation: 1,
        width: 1,
        height: 1,
        count: 1,
        gpuBytes,
        cpuBytes,
        resources: {
            textures: destroyed.slice(0, 5).map((destroy) => ({ destroy }) as unknown as GPUTexture),
            metadataBuffer: { destroy: destroyed[5] } as unknown as GPUBuffer,
        },
        pinCount: 0,
        displayedRefs: 0,
        pendingRefs: 0,
        activeRefs: 0,
        lastUsedFrame: frame,
        destroyed,
    };
}

describe("splat source cache", () => {
    it("does not double-grant retirement-pending GPU bytes", () => {
        const retired: Array<() => void> = [];
        const cache = createSplatSourceCache(100, 50, (dispose) => retired.push(dispose));
        const oldest = entry("https://a/old", 40, 20, 1);
        const newer = entry("https://a/new", 50, 20, 2);
        expect(admitSplatSource(cache, oldest)).toBe(true);
        expect(admitSplatSource(cache, newer)).toBe(true);
        expect(admitSplatSource(cache, entry("https://a/in", 55, 25, 3))).toBe(false);
        expect(evictSplatSource(cache, oldest.url)).toBe(true);
        expect(evictSplatSource(cache, newer.url)).toBe(true);
        expect(cache.allocatedGpuBytes).toBe(90);
        expect(cache.ledger.residentBytes).toBe(0);
        expect(cache.ledger.allocatedBytes).toBe(90);
        retired.forEach((retire) => retire());
        expect(cache.ledger.allocatedBytes).toBe(0);
        const incoming = entry("https://a/in", 55, 25, 3);
        expect(admitSplatSource(cache, incoming)).toBe(true);
        expect([...cache.entries.keys()]).toEqual(["https://a/in"]);
        expect(cache.residentGpuBytes).toBe(55);
        expect(cache.allocatedGpuBytes).toBe(55);
        expect(cache.ledger.allocatedBytes).toBe(55);
        expect(cache.residentCpuBytes).toBe(25);

        expect(oldest.destroyed.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
        expect(newer.destroyed.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
    });

    it("uses shared-ledger pressure to retire only enough unprotected LRU sources without freeing allocated bytes early", () => {
        const retired: Array<() => void> = [];
        const cache = createSplatSourceCache(100, 50, (dispose) => retired.push(dispose));
        expect(cache.ledger.tryReserve(60)).toBe(true);
        const oldest = entry("https://a/old", 20, 1, 1);
        const protectedEntry = entry("https://a/protected", 20, 1, 2);
        expect(admitSplatSource(cache, oldest)).toBe(true);
        expect(admitSplatSource(cache, protectedEntry)).toBe(true);
        setSplatSourceProtection(cache, protectedEntry.url, { activeRefs: 1 });
        const evicted: string[] = [];

        expect(reserveSplatSourceGpuBytes(cache, 20, (candidate) => evicted.push(candidate.url))).toBe(false);
        expect(evicted).toEqual([oldest.url]);
        expect([...cache.entries.keys()]).toEqual([protectedEntry.url]);
        expect(cache.ledger.allocatedBytes).toBe(100);
        expect(cache.ledger.residentBytes).toBe(80);
        expect(cache.retiringGpuBytes).toBe(20);
        expect(oldest.destroyed.every((destroy) => destroy.mock.calls.length === 0)).toBe(true);
        expect(canReserveSplatSourceGpuBytes(cache, 20)).toBe(false);
        expect(reserveSplatSourceGpuBytes(cache, 20, (candidate) => evicted.push(candidate.url))).toBe(false);
        expect(evicted).toEqual([oldest.url]);
        expect(retired).toHaveLength(1);

        retired[0]!();
        expect(cache.ledger.allocatedBytes).toBe(80);
        expect(cache.retiringGpuBytes).toBe(0);
        expect(oldest.destroyed.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
        expect(canReserveSplatSourceGpuBytes(cache, 20)).toBe(true);
        expect(reserveSplatSourceGpuBytes(cache, 20, () => undefined)).toBe(true);
        expect(cache.ledger.allocatedBytes).toBe(100);
    });

    it("protects pinned, displayed, pending, and active-generation sources", () => {
        for (const key of ["pinCount", "displayedRefs", "pendingRefs", "activeRefs"] as const) {
            const cache = createSplatSourceCache(10, 10);
            const protectedEntry = entry(`https://a/${key}`, 10, 1, 0);
            expect(admitSplatSource(cache, protectedEntry)).toBe(true);
            setSplatSourceProtection(cache, protectedEntry.url, { [key]: 1 });
            expect(evictSplatSource(cache, protectedEntry.url)).toBe(false);
            const rejected = entry("https://a/rejected", 1, 1, 1);
            expect(admitSplatSource(cache, rejected)).toBe(false);
            expect(rejected.destroyed.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
        }
    });

    it("rejects over-budget entries without changing accounting and disposes idempotently", () => {
        const cache = createSplatSourceCache(10, 5);
        const tooLarge = entry("https://a/large", 11, 1, 0);
        expect(admitSplatSource(cache, tooLarge)).toBe(false);
        expect(cache.residentGpuBytes).toBe(0);
        expect(cache.allocatedGpuBytes).toBe(0);

        const accepted = entry("https://a/ok", 10, 5, 0);
        expect(admitSplatSource(cache, accepted)).toBe(true);
        disposeSplatSourceCache(cache);
        disposeSplatSourceCache(cache);
        expect(cache.entries.size).toBe(0);
        expect(cache.residentGpuBytes).toBe(0);
        expect(cache.allocatedGpuBytes).toBe(0);
        expect(accepted.destroyed.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
    });
});
