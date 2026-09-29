/** MeshLoD GPU cache — the immutable geometry arena and its 64 KiB block allocator.
 *
 *  One storage arena is allocated at the immutable rounded `cacheCapacityBytes`
 *  (architecture 11.4). Residency is tracked in fixed 64 KiB blocks: pinned coarse
 *  pages are allocated first at the start of the arena, and later fine pages take
 *  64–256 KiB contiguous runs via deterministic first-fit. The allocator only owns
 *  block bookkeeping and the arena `GPUBuffer`; page decode/upload and eviction
 *  policy live in the runtime/scheduler. */

import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { MeshLoDPageRecord, MeshLoDPageRuntime } from "./mesh-lod-runtime.js";
import { PAGE_ALIGNMENT, PAGE_MAX_BYTES } from "./mesh-lod-format.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";

/** 64 KiB allocation block — the arena's granularity. */
export const ARENA_BLOCK_BYTES = PAGE_ALIGNMENT;

/** Round a byte length down to a whole number of 64 KiB blocks. */
export function floorToBlocks(bytes: number): number {
    return Math.floor(bytes / ARENA_BLOCK_BYTES) * ARENA_BLOCK_BYTES;
}

/** Round a page's meaningful byte length up to its 64 KiB-multiple allocation,
 *  with a 64 KiB minimum — mirrors the converter's `pageAllocation`. */
export function roundPageAllocation(bytes: number): number {
    const rounded = Math.ceil(bytes / ARENA_BLOCK_BYTES) * ARENA_BLOCK_BYTES;
    return Math.max(rounded, ARENA_BLOCK_BYTES);
}

/** Total rounded arena bytes required by every pinned page. This is the minimum
 *  viable capacity/budget: loading fails with `MLOD_BUDGET_TOO_SMALL` below it. */
export function pinnedAllocationBytes(pageRecords: readonly MeshLoDPageRecord[]): number {
    let total = 0;
    for (const page of pageRecords) {
        if (page.pinned) {
            total += roundPageAllocation(page.decodedBytes);
        }
    }
    return total;
}

/** The immutable geometry arena: a fixed storage `GPUBuffer` plus a per-block
 *  residency bitmap. Never reallocated for the asset's lifetime (only recreated
 *  on device recovery). */
export interface MeshLoDArena {
    /** Immutable arena capacity in bytes, a multiple of 64 KiB. */
    readonly capacityBytes: number;
    /** Number of 64 KiB blocks in the arena. */
    readonly blockCount: number;
    /** The raw geometry-arena storage buffer (read-only storage + copy dest). */
    readonly buffer: GPUBuffer;
    /** Per-block state: `0` = free, `1` = allocated. */
    readonly blocks: Uint8Array;
    /** Per-block pinned flag: pinned blocks are never evicted or relocated. */
    readonly pinnedBlocks: Uint8Array;
    /** Count of currently allocated blocks (pinned + resident fine). */
    committedBlocks: number;
    /** Count of blocks reserved by pinned pages. */
    pinnedCount: number;
}

/** Create the immutable geometry arena. `capacityBytes` is rounded down to a whole
 *  number of 64 KiB blocks and clamped to the device's storage-buffer limits; a
 *  capacity that cannot hold `minimumBytes` (the pinned allocation) throws
 *  `MLOD_DEVICE_LIMIT`. */
export function createMeshLoDArena(engine: EngineContext, capacityBytes: number, minimumBytes: number, label?: string): MeshLoDArena {
    const limits = engine._device.limits;
    const deviceCap = Math.min(limits?.maxStorageBufferBindingSize ?? capacityBytes, limits?.maxBufferSize ?? capacityBytes);
    const rounded = floorToBlocks(Math.min(capacityBytes, deviceCap));
    if (rounded < minimumBytes || rounded < ARENA_BLOCK_BYTES) {
        throw createMeshLoDError("MLOD_DEVICE_LIMIT", "device storage limits cannot hold the pinned geometry arena", { expected: minimumBytes, actual: rounded });
    }
    const blockCount = rounded / ARENA_BLOCK_BYTES;
    const buffer = engine._device.createBuffer({ label: label ?? "mesh-lod-arena", size: rounded, usage: BU.STORAGE | BU.COPY_DST });
    return {
        capacityBytes: rounded,
        blockCount,
        buffer,
        blocks: new Uint8Array(blockCount),
        pinnedBlocks: new Uint8Array(blockCount),
        committedBlocks: 0,
        pinnedCount: 0,
    };
}

/** Reserve a contiguous 64–256 KiB run for a decoded page using deterministic
 *  first-fit. Returns the byte offset of the run, or `null` when no contiguous run
 *  of the required block count is free. Pinned pages must allocate before any fine
 *  pages so they occupy the arena prefix. */
export function allocateArenaRun(arena: MeshLoDArena, decodedBytes: number, pinned: boolean): number | null {
    const runBytes = roundPageAllocation(decodedBytes);
    if (runBytes > PAGE_MAX_BYTES) {
        return null;
    }
    const need = runBytes / ARENA_BLOCK_BYTES;
    const { blocks, pinnedBlocks, blockCount } = arena;
    let start = 0;
    while (start + need <= blockCount) {
        let free = 0;
        while (free < need && blocks[start + free] === 0) {
            free++;
        }
        if (free === need) {
            for (let i = 0; i < need; i++) {
                blocks[start + i] = 1;
                pinnedBlocks[start + i] = pinned ? 1 : 0;
            }
            arena.committedBlocks += need;
            if (pinned) {
                arena.pinnedCount += need;
            }
            return start * ARENA_BLOCK_BYTES;
        }
        // Skip past the blocked cell (start + free is the first occupied block).
        start += free + 1;
    }
    return null;
}

/** Release a previously allocated run. Pinned runs are never freed except on
 *  disposal/device loss. */
export function freeArenaRun(arena: MeshLoDArena, byteOffset: number, decodedBytes: number): void {
    const runBytes = roundPageAllocation(decodedBytes);
    const need = runBytes / ARENA_BLOCK_BYTES;
    const startBlock = byteOffset / ARENA_BLOCK_BYTES;
    for (let i = 0; i < need; i++) {
        const b = startBlock + i;
        if (arena.blocks[b] === 1) {
            arena.blocks[b] = 0;
            arena.committedBlocks--;
            if (arena.pinnedBlocks[b] === 1) {
                arena.pinnedCount--;
            }
            arena.pinnedBlocks[b] = 0;
        }
    }
}

/** Bytes currently committed to resident blocks. */
export function arenaUsedBytes(arena: MeshLoDArena): number {
    return arena.committedBlocks * ARENA_BLOCK_BYTES;
}

/** Destroy the arena's GPU buffer. Idempotent-safe when called once during disposal. */
export function destroyMeshLoDArena(arena: MeshLoDArena): void {
    arena.buffer.destroy();
    arena.blocks.fill(0);
    arena.pinnedBlocks.fill(0);
    arena.committedBlocks = 0;
    arena.pinnedCount = 0;
}

// ─── GPU residency eviction (architecture §11.4) ─────────────────────

/** Effective-budget + hysteresis inputs for one reservation attempt. */
export interface MeshLoDEvictionPolicy {
    /** Effective GPU residency budget in bytes (≤ arena capacity). Pinned pages count
     *  toward it. Changing the budget never reallocates the arena. */
    readonly budgetBytes: number;
    /** Current selection frame, for LRU age and residency-hold eligibility. */
    readonly currentFrame: number;
    /** Frames a resident fine page must be untouched before it can be evicted. */
    readonly residencyHoldFrames: number;
}

/** A resident fine page is an eviction candidate only when it is unpinned, fully
 *  GPU-resident (never mid-fetch/decode/upload), unreferenced by the current frame,
 *  and older than the residency hold (REQ-CACHE-3, REQ-CACHE-4). */
function isEvictable(page: MeshLoDPageRuntime, record: MeshLoDPageRecord, policy: MeshLoDEvictionPolicy): boolean {
    return (
        page.state === "gpu-resident" &&
        !record.pinned &&
        page.frameRefCount === 0 &&
        page.arenaOffset >= 0 &&
        page.arenaBytes > 0 &&
        policy.currentFrame - page.lastUsedFrame >= policy.residencyHoldFrames
    );
}

/** Victim priority: oldest last-used first, then lower demand priority, then higher
 *  page id (architecture §11.4). Returns true when `a` should be evicted before `b`. */
function victimBefore(a: MeshLoDPageRuntime, b: MeshLoDPageRuntime): boolean {
    if (a.lastUsedFrame !== b.lastUsedFrame) {
        return a.lastUsedFrame < b.lastUsedFrame;
    }
    if (a.priority !== b.priority) {
        return a.priority < b.priority;
    }
    return a.id > b.id;
}

function pickVictim(pages: readonly MeshLoDPageRuntime[], records: readonly MeshLoDPageRecord[], policy: MeshLoDEvictionPolicy): MeshLoDPageRuntime | null {
    let best: MeshLoDPageRuntime | null = null;
    for (const page of pages) {
        if (!isEvictable(page, records[page.id]!, policy)) {
            continue;
        }
        if (!best || victimBefore(page, best)) {
            best = page;
        }
    }
    return best;
}

/** Free a resident page's arena run and reset its runtime record to `unrequested`,
 *  appending its id to `evicted` for GPU page-state sync. */
export function evictMeshLoDPage(arena: MeshLoDArena, page: MeshLoDPageRuntime, evicted: number[]): void {
    if (page.arenaOffset >= 0 && page.arenaBytes > 0) {
        freeArenaRun(arena, page.arenaOffset, page.arenaBytes);
    }
    page.state = "unrequested";
    page.arenaOffset = -1;
    page.arenaBytes = 0;
    page.indices = null;
    page.frameRefCount = 0;
    page.priority = 0;
    evicted.push(page.id);
}

/** Reserve a contiguous decoded-page run for a fine page within the effective budget,
 *  evicting eligible resident victims (oldest use, then lower priority, then higher id)
 *  first to satisfy the budget and then to defragment. Every evicted page's id is
 *  appended to `evicted` so the caller can sync GPU page-state and diagnostics. Returns
 *  the reserved byte offset, or `null` when the page cannot fit without evicting
 *  protected (pinned / current-frame / in-flight / young) pages — in which case nothing
 *  is allocated and the page stays pending for a later frame (REQ-CACHE-1, §11.4). */
export function reserveMeshLoDArenaRun(
    arena: MeshLoDArena,
    pages: readonly MeshLoDPageRuntime[],
    records: readonly MeshLoDPageRecord[],
    decodedBytes: number,
    policy: MeshLoDEvictionPolicy,
    evicted: number[]
): number | null {
    const newBytes = roundPageAllocation(decodedBytes);
    if (newBytes > PAGE_MAX_BYTES) {
        return null;
    }
    // 1. Budget: evict eligible victims until the new page fits within the effective
    //    budget. Committed residency (pinned + resident fine) must not exceed budget.
    while (arenaUsedBytes(arena) + newBytes > policy.budgetBytes) {
        const victim = pickVictim(pages, records, policy);
        if (!victim) {
            return null;
        }
        evictMeshLoDPage(arena, victim, evicted);
    }
    // 2. Allocate; on fragmentation evict more eligible victims and retry until a
    //    contiguous run is available or no eligible victims remain.
    let offset = allocateArenaRun(arena, decodedBytes, false);
    while (offset === null) {
        const victim = pickVictim(pages, records, policy);
        if (!victim) {
            return null;
        }
        evictMeshLoDPage(arena, victim, evicted);
        offset = allocateArenaRun(arena, decodedBytes, false);
    }
    return offset;
}

/** Evict eligible resident victims (oldest use, then lower priority, then higher id)
 *  until committed residency fits within `policy.budgetBytes`, or no eligible victim
 *  remains. Applies a lowered effective `cacheBudgetBytes` deterministically without
 *  touching pinned, current-frame-referenced, in-flight, or held pages. Every evicted
 *  id is appended to `evicted` for GPU page-state and diagnostics sync (§11.4). */
export function evictMeshLoDToBudget(
    arena: MeshLoDArena,
    pages: readonly MeshLoDPageRuntime[],
    records: readonly MeshLoDPageRecord[],
    policy: MeshLoDEvictionPolicy,
    evicted: number[]
): void {
    while (arenaUsedBytes(arena) > policy.budgetBytes) {
        const victim = pickVictim(pages, records, policy);
        if (!victim) {
            return;
        }
        evictMeshLoDPage(arena, victim, evicted);
    }
}

// ─── CPU encoded-page cache (architecture §11.5) ─────────────────────

interface CpuCacheEntry {
    bytes: Uint8Array;
    pinned: boolean;
    lastUsed: number;
}

/** Retained encoded (`.mlod` stored) page bytes, bounded by `budgetBytes`. Pinned
 *  encoded pages are always retained and count toward the budget; unpinned pages evict
 *  by the same last-used ordering. Retained bytes let device recovery re-decode without
 *  re-fetching. */
export interface MeshLoDCpuPageCache {
    /** Mutable byte budget (default `cpuPageCacheBytes`). */
    budgetBytes: number;
    /** Sum of retained entry byte lengths. */
    usedBytes: number;
    readonly entries: Map<number, CpuCacheEntry>;
}

export function createMeshLoDCpuPageCache(budgetBytes: number): MeshLoDCpuPageCache {
    return { budgetBytes, usedBytes: 0, entries: new Map() };
}

/** Bytes currently retained by the CPU encoded-page cache. */
export function cpuCacheUsedBytes(cache: MeshLoDCpuPageCache): number {
    return cache.usedBytes;
}

/** Evict unpinned entries by oldest last-used (ties: higher id) until within budget or
 *  no evictable entry remains. `protectId` is never evicted (the just-inserted page). */
function evictCpuToFit(cache: MeshLoDCpuPageCache, protectId: number): void {
    while (cache.usedBytes > cache.budgetBytes) {
        let victimId = -1;
        let victim: CpuCacheEntry | null = null;
        for (const [id, entry] of cache.entries) {
            if (entry.pinned || id === protectId) {
                continue;
            }
            if (!victim || entry.lastUsed < victim.lastUsed || (entry.lastUsed === victim.lastUsed && id > victimId)) {
                victim = entry;
                victimId = id;
            }
        }
        if (!victim) {
            return;
        }
        cache.usedBytes -= victim.bytes.byteLength;
        cache.entries.delete(victimId);
    }
}

/** Retain a page's encoded bytes, then evict unpinned entries to fit the budget. The
 *  just-inserted page is protected from this call's eviction. */
export function putMeshLoDCpuPage(cache: MeshLoDCpuPageCache, pageId: number, bytes: Uint8Array, pinned: boolean, frame: number): void {
    const existing = cache.entries.get(pageId);
    if (existing) {
        cache.usedBytes += bytes.byteLength - existing.bytes.byteLength;
        existing.bytes = bytes;
        existing.pinned = existing.pinned || pinned;
        existing.lastUsed = frame;
    } else {
        cache.entries.set(pageId, { bytes, pinned, lastUsed: frame });
        cache.usedBytes += bytes.byteLength;
    }
    evictCpuToFit(cache, pageId);
}

/** Return a retained page's encoded bytes (touching its last-used frame), or `null`. */
export function getMeshLoDCpuPage(cache: MeshLoDCpuPageCache, pageId: number, frame: number): Uint8Array | null {
    const entry = cache.entries.get(pageId);
    if (!entry) {
        return null;
    }
    entry.lastUsed = frame;
    return entry.bytes;
}

/** Refresh a retained page's last-used frame without reading its bytes. */
export function touchMeshLoDCpuPage(cache: MeshLoDCpuPageCache, pageId: number, frame: number): void {
    const entry = cache.entries.get(pageId);
    if (entry) {
        entry.lastUsed = frame;
    }
}

/** Apply a new CPU-cache byte budget and evict unpinned entries to fit. */
export function setMeshLoDCpuCacheBudget(cache: MeshLoDCpuPageCache, budgetBytes: number): void {
    cache.budgetBytes = budgetBytes;
    evictCpuToFit(cache, -1);
}

/** Drop every retained entry (pinned and unpinned) and reset the used byte count.
 *  Called on asset disposal once scene registries have stopped drawing the asset, so
 *  retained encoded bytes and decoded metadata are released (§14.2). */
export function clearMeshLoDCpuPageCache(cache: MeshLoDCpuPageCache): void {
    cache.entries.clear();
    cache.usedBytes = 0;
}
