/** MeshLoD cache/arena unit tests (Task 4.2).
 *
 *  Cover the pinned-allocation math and the 64 KiB block arena allocator that back
 *  the loader's budget checks and pinned residency, plus the device-limit clamp in
 *  `createMeshLoDArena`. No decode or real device is involved. */

import { describe, expect, it } from "vitest";
import {
    ARENA_BLOCK_BYTES,
    allocateArenaRun,
    arenaUsedBytes,
    createMeshLoDArena,
    floorToBlocks,
    freeArenaRun,
    pinnedAllocationBytes,
    roundPageAllocation,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-cache.js";
import type { MeshLoDPageRecord } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import { createMockDevice, createMockEngine } from "./fixtures/gpu-mock.js";

const BLOCK = 64 * 1024;

function page(decodedBytes: number, pinned: boolean): MeshLoDPageRecord {
    return {
        offset: 0,
        storedBytes: decodedBytes,
        meaningfulBytes: decodedBytes,
        decodedBytes,
        crc: 0,
        vertexCount: 0,
        localIndexCount: 0,
        vertexByteOffset: 0,
        indexByteOffset: 0,
        firstCluster: 0,
        clusterCount: 0,
        pinned,
        coarse: pinned,
        minDepth: 0,
        maxDepth: 0,
    };
}

describe("pinned-allocation math", () => {
    it("rounds each page up to a 64 KiB-multiple with a 64 KiB minimum", () => {
        expect(roundPageAllocation(1)).toBe(BLOCK);
        expect(roundPageAllocation(BLOCK)).toBe(BLOCK);
        expect(roundPageAllocation(BLOCK + 1)).toBe(2 * BLOCK);
        expect(roundPageAllocation(3 * BLOCK)).toBe(3 * BLOCK);
    });

    it("floors a capacity down to whole blocks", () => {
        expect(floorToBlocks(BLOCK - 1)).toBe(0);
        expect(floorToBlocks(BLOCK + 1)).toBe(BLOCK);
        expect(floorToBlocks(5 * BLOCK)).toBe(5 * BLOCK);
    });

    it("sums only pinned pages' rounded allocations", () => {
        const records = [page(BLOCK, true), page(BLOCK + 1, true), page(4 * BLOCK, false)];
        expect(pinnedAllocationBytes(records)).toBe(BLOCK + 2 * BLOCK);
        expect(ARENA_BLOCK_BYTES).toBe(BLOCK);
    });
});

describe("arena block allocator", () => {
    it("allocates pinned pages contiguously from the prefix and tracks accounting", () => {
        const { engine } = createMockEngine();
        const arena = createMeshLoDArena(engine, 8 * BLOCK, 3 * BLOCK);
        const a = allocateArenaRun(arena, 2 * BLOCK, true); // 2 blocks
        const b = allocateArenaRun(arena, BLOCK, true); // 1 block
        expect(a).toBe(0);
        expect(b).toBe(2 * BLOCK);
        expect(arena.pinnedCount).toBe(3);
        expect(arena.committedBlocks).toBe(3);
        expect(arenaUsedBytes(arena)).toBe(3 * BLOCK);
    });

    it("first-fits fine pages into gaps freed by eviction", () => {
        const { engine } = createMockEngine();
        const arena = createMeshLoDArena(engine, 8 * BLOCK, 0);
        const a = allocateArenaRun(arena, 2 * BLOCK, false); // blocks 0-1
        const b = allocateArenaRun(arena, 2 * BLOCK, false); // blocks 2-3
        expect(a).toBe(0);
        expect(b).toBe(2 * BLOCK);
        freeArenaRun(arena, a!, 2 * BLOCK); // free blocks 0-1
        const c = allocateArenaRun(arena, BLOCK, false); // first-fit → block 0
        expect(c).toBe(0);
        expect(arena.committedBlocks).toBe(3);
    });

    it("returns null when no contiguous run is free", () => {
        const { engine } = createMockEngine();
        const arena = createMeshLoDArena(engine, 3 * BLOCK, 0);
        allocateArenaRun(arena, BLOCK, false); // block 0
        allocateArenaRun(arena, BLOCK, false); // block 1
        // Only block 2 free — a 2-block run cannot fit.
        expect(allocateArenaRun(arena, 2 * BLOCK, false)).toBeNull();
    });
});

describe("createMeshLoDArena device limits", () => {
    it("rounds the capacity down to whole 64 KiB blocks", () => {
        const { engine } = createMockEngine();
        const arena = createMeshLoDArena(engine, 5 * BLOCK + 123, BLOCK);
        expect(arena.capacityBytes).toBe(5 * BLOCK);
        expect(arena.blockCount).toBe(5);
        expect(arena.buffer.size).toBe(5 * BLOCK);
    });

    it("clamps the arena to the device storage limit", () => {
        const device = createMockDevice(2 * BLOCK);
        const { engine } = createMockEngine(device);
        const arena = createMeshLoDArena(engine, 16 * BLOCK, BLOCK);
        expect(arena.capacityBytes).toBe(2 * BLOCK);
    });

    it("throws MLOD_DEVICE_LIMIT when limits cannot hold the pinned pages", () => {
        const device = createMockDevice(BLOCK); // only one block available
        const { engine } = createMockEngine(device);
        try {
            createMeshLoDArena(engine, 16 * BLOCK, 4 * BLOCK); // need 4 blocks
            throw new Error("expected MLOD_DEVICE_LIMIT");
        } catch (error) {
            expect(isMeshLoDError(error) && error.code).toBe("MLOD_DEVICE_LIMIT");
        }
    });
});
