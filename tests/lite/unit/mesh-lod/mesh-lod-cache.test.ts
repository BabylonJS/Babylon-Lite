/** MeshLoD bounded GPU/CPU page-cache unit tests.
 *
 *  Exercises the deterministic 64 KiB block arena eviction policy and the CPU
 *  encoded-page cache (architecture §11.4–§11.5) directly against a mock device arena
 *  and synthetic page runtime records — no decoder or network. Proves the budget
 *  boundary, the strict within-budget accounting (no more than one active upload's
 *  worth over budget), fragmentation-driven extra eviction, pinned/current-frame/
 *  in-flight/young victim exclusion, the oldest-use → lower-priority → higher-id victim
 *  ordering, the 120-frame residency hold, and CPU-cache LRU eviction with pinned
 *  retention. */

import { describe, expect, it } from "vitest";
import {
    ARENA_BLOCK_BYTES,
    allocateArenaRun,
    arenaUsedBytes,
    cpuCacheUsedBytes,
    createMeshLoDArena,
    createMeshLoDCpuPageCache,
    evictMeshLoDToBudget,
    getMeshLoDCpuPage,
    putMeshLoDCpuPage,
    reserveMeshLoDArenaRun,
    setMeshLoDCpuCacheBudget,
    type MeshLoDEvictionPolicy,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-cache.js";
import type { MeshLoDPageRecord, MeshLoDPageRuntime } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import { createMockEngine } from "./fixtures/gpu-mock.js";

const BLOCK = ARENA_BLOCK_BYTES;

interface PageOptions {
    pinned?: boolean;
    state?: MeshLoDPageRuntime["state"];
    lastUsedFrame?: number;
    priority?: number;
    frameRefCount?: number;
}

interface Fixture {
    arena: ReturnType<typeof createMeshLoDArena>;
    pages: MeshLoDPageRuntime[];
    records: MeshLoDPageRecord[];
}

/** Build an arena with a list of pages, each `blocks` 64 KiB blocks, allocated in id
 *  order (pinned first). Pages default to resident, old, unreferenced (evictable). */
function buildFixture(capacityBlocks: number, specs: (PageOptions & { blocks: number })[]): Fixture {
    const { engine } = createMockEngine();
    const pinnedBytes = specs.filter((s) => s.pinned).reduce((sum, s) => sum + s.blocks * BLOCK, 0);
    const arena = createMeshLoDArena(engine, capacityBlocks * BLOCK, Math.max(pinnedBytes, BLOCK));
    const pages: MeshLoDPageRuntime[] = [];
    const records: MeshLoDPageRecord[] = [];
    // Allocate pinned first so they occupy the arena prefix (matches load).
    const order = specs.map((_, i) => i).sort((a, b) => Number(!!specs[b]!.pinned) - Number(!!specs[a]!.pinned) || a - b);
    const offsets = new Map<number, number>();
    for (const id of order) {
        const spec = specs[id]!;
        const offset = allocateArenaRun(arena, spec.blocks * BLOCK, !!spec.pinned)!;
        offsets.set(id, offset);
    }
    for (let id = 0; id < specs.length; id++) {
        const spec = specs[id]!;
        const decodedBytes = spec.blocks * BLOCK;
        pages.push({
            id,
            state: spec.state ?? "gpu-resident",
            arenaOffset: offsets.get(id)!,
            arenaBytes: decodedBytes,
            vertexByteOffset: 0,
            indices: null,
            lastUsedFrame: spec.lastUsedFrame ?? 0,
            priority: spec.priority ?? 0,
            frameRefCount: spec.frameRefCount ?? 0,
        });
        records.push({ pinned: !!spec.pinned, decodedBytes } as unknown as MeshLoDPageRecord);
    }
    return { arena, pages, records };
}

const HOLD = 120;

function policy(currentFrame: number, budgetBlocks: number): MeshLoDEvictionPolicy {
    return { budgetBytes: budgetBlocks * BLOCK, currentFrame, residencyHoldFrames: HOLD };
}

describe("MeshLoD GPU cache — reservation & eviction", () => {
    it("stays within the effective budget by evicting one eligible victim at the boundary", () => {
        // 1 pinned + 4 fine = 5 blocks committed, budget = 5 blocks. A new page must evict.
        const f = buildFixture(10, [
            { blocks: 1, pinned: true },
            { blocks: 1, lastUsedFrame: 10 },
            { blocks: 1, lastUsedFrame: 20 },
            { blocks: 1, lastUsedFrame: 30 },
            { blocks: 1, lastUsedFrame: 40 },
        ]);
        expect(arenaUsedBytes(f.arena)).toBe(5 * BLOCK);
        const evicted: number[] = [];
        const offset = reserveMeshLoDArenaRun(f.arena, f.pages, f.records, BLOCK, policy(200, 5), evicted);
        expect(offset).not.toBeNull();
        expect(evicted).toEqual([1]); // oldest fine page (lastUsed 10)
        expect(arenaUsedBytes(f.arena)).toBeLessThanOrEqual(5 * BLOCK); // never over budget
    });

    it("orders victims by oldest use, then lower priority, then higher id", () => {
        const f = buildFixture(10, [
            { blocks: 1, pinned: true },
            { blocks: 1, lastUsedFrame: 50, priority: 0.9 },
            { blocks: 1, lastUsedFrame: 50, priority: 0.1 },
            { blocks: 1, lastUsedFrame: 50, priority: 0.1 },
        ]);
        // Committed 4 blocks, budget 4 → one eviction needed.
        const evicted: number[] = [];
        reserveMeshLoDArenaRun(f.arena, f.pages, f.records, BLOCK, policy(300, 4), evicted);
        // Same frame → lower priority wins (pages 2,3 both 0.1); tie broken by higher id → page 3.
        expect(evicted).toEqual([3]);
    });

    it("evicts additional pages to defragment a contiguous run", () => {
        // 3 fine pages contiguous, budget 4 (capacity 4). Reserve a 2-block page:
        // budget forces one eviction, then fragmentation forces a second so 2 blocks are contiguous.
        const f = buildFixture(4, [
            { blocks: 1, lastUsedFrame: 10 },
            { blocks: 1, lastUsedFrame: 20 },
            { blocks: 1, lastUsedFrame: 30 },
        ]);
        expect(arenaUsedBytes(f.arena)).toBe(3 * BLOCK);
        const evicted: number[] = [];
        const offset = reserveMeshLoDArenaRun(f.arena, f.pages, f.records, 2 * BLOCK, policy(300, 4), evicted);
        expect(offset).not.toBeNull();
        expect(evicted).toEqual([0, 1]); // oldest two → yields a contiguous 2-block run at block 0
        expect(offset).toBe(0);
        expect(arenaUsedBytes(f.arena)).toBeLessThanOrEqual(4 * BLOCK);
    });

    it("never evicts pinned pages, returning null when only pinned space would fit", () => {
        // Pinned fills the whole budget; a new page cannot be reserved without evicting it.
        const f = buildFixture(4, [
            { blocks: 2, pinned: true },
            { blocks: 1, lastUsedFrame: 5, frameRefCount: 1 },
        ]);
        const evicted: number[] = [];
        const offset = reserveMeshLoDArenaRun(f.arena, f.pages, f.records, 2 * BLOCK, policy(300, 3), evicted);
        expect(offset).toBeNull();
        expect(evicted).toEqual([]);
        expect(f.pages[0]!.state).toBe("gpu-resident"); // pinned untouched
    });

    it("excludes current-frame-referenced, in-flight, and young pages from eviction", () => {
        const f = buildFixture(6, [
            { blocks: 1, pinned: true },
            { blocks: 1, lastUsedFrame: 10, frameRefCount: 2 }, // referenced this frame
            { blocks: 1, lastUsedFrame: 10, state: "uploading" }, // mid-upload
            { blocks: 1, lastUsedFrame: 10, state: "fetching" }, // in flight
            { blocks: 1, lastUsedFrame: 299 }, // too young (age 1 < 120)
        ]);
        const evicted: number[] = [];
        const offset = reserveMeshLoDArenaRun(f.arena, f.pages, f.records, BLOCK, policy(300, 5), evicted);
        expect(offset).toBeNull(); // no eligible victim
        expect(evicted).toEqual([]);
    });

    it("honours the 120-frame residency hold before a page becomes evictable", () => {
        const f = buildFixture(6, [
            { blocks: 1, pinned: true },
            { blocks: 1, lastUsedFrame: 100 },
            { blocks: 1, lastUsedFrame: 110 },
        ]);
        // At frame 219 page 1 is 119 frames old (< 120) and page 2 is younger → neither evictable.
        let evicted: number[] = [];
        expect(reserveMeshLoDArenaRun(f.arena, f.pages, f.records, BLOCK, policy(219, 3), evicted)).toBeNull();
        expect(evicted).toEqual([]);
        // At frame 220 page 1 reaches the 120-frame hold (page 2 is still younger) → page 1 evictable.
        evicted = [];
        const offset = reserveMeshLoDArenaRun(f.arena, f.pages, f.records, BLOCK, policy(220, 3), evicted);
        expect(offset).not.toBeNull();
        expect(evicted).toEqual([1]);
    });

    it("reserves without eviction when the budget already has contiguous room", () => {
        const f = buildFixture(8, [
            { blocks: 1, pinned: true },
            { blocks: 1, lastUsedFrame: 10 },
        ]);
        const evicted: number[] = [];
        const offset = reserveMeshLoDArenaRun(f.arena, f.pages, f.records, BLOCK, policy(300, 8), evicted);
        expect(offset).not.toBeNull();
        expect(evicted).toEqual([]);
        expect(arenaUsedBytes(f.arena)).toBe(3 * BLOCK);
    });
});

describe("MeshLoD GPU cache — trim to a reduced budget", () => {
    it("evicts eligible victims until committed residency fits a lowered budget", () => {
        const f = buildFixture(10, [
            { blocks: 1, pinned: true },
            { blocks: 1, lastUsedFrame: 10 },
            { blocks: 1, lastUsedFrame: 20 },
            { blocks: 1, lastUsedFrame: 30 },
        ]);
        expect(arenaUsedBytes(f.arena)).toBe(4 * BLOCK);
        const evicted: number[] = [];
        evictMeshLoDToBudget(f.arena, f.pages, f.records, policy(300, 2), evicted); // budget = 2 blocks
        expect(arenaUsedBytes(f.arena)).toBeLessThanOrEqual(2 * BLOCK);
        expect(evicted).toEqual([1, 2]); // oldest two unpinned pages, pinned untouched
        expect(f.pages[0]!.state).toBe("gpu-resident");
    });

    it("stops at the protected floor, never evicting pinned or held pages below budget", () => {
        const f = buildFixture(10, [
            { blocks: 2, pinned: true },
            { blocks: 1, lastUsedFrame: 10, frameRefCount: 1 }, // referenced this frame
        ]);
        const evicted: number[] = [];
        evictMeshLoDToBudget(f.arena, f.pages, f.records, policy(300, 1), evicted); // budget below committed
        // Neither the pinned page nor the current-frame page is evictable, so the trim halts.
        expect(evicted).toEqual([]);
        expect(arenaUsedBytes(f.arena)).toBe(3 * BLOCK);
    });

    it("is a no-op when committed residency already fits the budget", () => {
        const f = buildFixture(10, [
            { blocks: 1, pinned: true },
            { blocks: 1, lastUsedFrame: 10 },
        ]);
        const evicted: number[] = [];
        evictMeshLoDToBudget(f.arena, f.pages, f.records, policy(300, 8), evicted);
        expect(evicted).toEqual([]);
        expect(arenaUsedBytes(f.arena)).toBe(2 * BLOCK);
    });
});

describe("MeshLoD CPU encoded-page cache", () => {
    function bytes(n: number): Uint8Array {
        return new Uint8Array(n);
    }

    it("accounts retained bytes and evicts unpinned pages LRU when over budget", () => {
        const cache = createMeshLoDCpuPageCache(3 * BLOCK);
        putMeshLoDCpuPage(cache, 0, bytes(BLOCK), false, 1);
        putMeshLoDCpuPage(cache, 1, bytes(BLOCK), false, 2);
        putMeshLoDCpuPage(cache, 2, bytes(BLOCK), false, 3);
        expect(cpuCacheUsedBytes(cache)).toBe(3 * BLOCK);
        // Fourth page exceeds budget → evict the oldest (page 0).
        putMeshLoDCpuPage(cache, 3, bytes(BLOCK), false, 4);
        expect(cache.entries.has(0)).toBe(false);
        expect(cache.entries.has(3)).toBe(true);
        expect(cpuCacheUsedBytes(cache)).toBe(3 * BLOCK);
    });

    it("always retains pinned encoded pages even over budget", () => {
        const cache = createMeshLoDCpuPageCache(2 * BLOCK);
        putMeshLoDCpuPage(cache, 0, bytes(BLOCK), true, 1); // pinned
        putMeshLoDCpuPage(cache, 1, bytes(BLOCK), true, 2); // pinned
        putMeshLoDCpuPage(cache, 2, bytes(BLOCK), false, 3); // unpinned pushes over budget
        // Both pinned pages stay; the unpinned page is evicted (protected only during its own insert).
        putMeshLoDCpuPage(cache, 3, bytes(BLOCK), false, 4);
        expect(cache.entries.has(0)).toBe(true);
        expect(cache.entries.has(1)).toBe(true);
        expect(cache.entries.has(3)).toBe(true);
        expect(cache.entries.has(2)).toBe(false);
    });

    it("touches last-used on read so LRU tracks access order", () => {
        const cache = createMeshLoDCpuPageCache(2 * BLOCK);
        putMeshLoDCpuPage(cache, 0, bytes(BLOCK), false, 1);
        putMeshLoDCpuPage(cache, 1, bytes(BLOCK), false, 2);
        expect(getMeshLoDCpuPage(cache, 0, 5)).not.toBeNull(); // page 0 now most-recently used
        putMeshLoDCpuPage(cache, 2, bytes(BLOCK), false, 6); // evicts LRU → page 1, not page 0
        expect(cache.entries.has(0)).toBe(true);
        expect(cache.entries.has(1)).toBe(false);
    });

    it("shrinks to a reduced budget by evicting unpinned pages", () => {
        const cache = createMeshLoDCpuPageCache(4 * BLOCK);
        putMeshLoDCpuPage(cache, 0, bytes(BLOCK), true, 1);
        putMeshLoDCpuPage(cache, 1, bytes(BLOCK), false, 2);
        putMeshLoDCpuPage(cache, 2, bytes(BLOCK), false, 3);
        setMeshLoDCpuCacheBudget(cache, 2 * BLOCK);
        expect(cpuCacheUsedBytes(cache)).toBeLessThanOrEqual(2 * BLOCK);
        expect(cache.entries.has(0)).toBe(true); // pinned retained
        expect(cache.entries.has(1)).toBe(false); // oldest unpinned evicted
    });
});
