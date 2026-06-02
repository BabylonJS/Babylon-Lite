// Chunk store + world block access. Chunks are generated lazily and
// deterministically on first access, so meshing a chunk can freely query
// neighbouring chunks (for face culling and AO) and they will always exist and
// agree at borders.

import { Block, blockLight } from "./blocks.js";
import { CHUNK_SX, CHUNK_SZ, WORLD_H, blockIndex, chunkKey } from "./constants.js";
import { generateChunk } from "./worldgen.js";
import { WorldLight } from "./world-light.js";

export interface Chunk {
    cx: number;
    cz: number;
    blocks: Uint8Array;
}

export class World {
    seed: number;
    readonly light: WorldLight;
    private readonly chunks = new Map<string, Chunk>();
    // Player-caused block deltas vs. the deterministic terrain, keyed by chunk then
    // by in-chunk linear index. Kept separate from chunk data so edits survive a
    // chunk being streamed out and regenerated, and so they can be serialised for
    // save/load. Simulation-only writes (water flooding) are NOT recorded — they
    // re-derive deterministically from the terrain + these edits on reload.
    private readonly edits = new Map<string, Map<number, number>>();
    // True once any light-emitting block (only player-placed glowstone) has ever
    // been recorded. Worldgen never emits light, so while this stays false the
    // light solver can stop scanning each column at the first opaque block instead
    // of walking the full 96-tall volume hunting for emitters — the dominant cost
    // of streaming-time light compute. Stays latched true for the session once set
    // (conservative: a removed emitter just keeps the slower full scan).
    private _anyEmitters = false;

    /** Whether any light-emitting block has ever been placed (see _anyEmitters). */
    get anyEmitters(): boolean {
        return this._anyEmitters;
    }

    constructor(seed: number) {
        this.seed = seed;
        this.light = new WorldLight(this);
    }

    /** Get (generating if necessary) the chunk containing chunk-coords (cx,cz). */
    getChunk(cx: number, cz: number): Chunk {
        const key = chunkKey(cx, cz);
        let chunk = this.chunks.get(key);
        if (!chunk) {
            const blocks = new Uint8Array(CHUNK_SX * CHUNK_SZ * WORLD_H);
            generateChunk(this.seed, cx, cz, blocks);
            // Replay any player edits recorded for this chunk on top of the freshly
            // generated terrain so streamed-out edits are never lost.
            const e = this.edits.get(key);
            if (e) for (const [idx, id] of e) blocks[idx] = id;
            chunk = { cx, cz, blocks };
            this.chunks.set(key, chunk);
        }
        return chunk;
    }

    /** True if the chunk is already generated (does not trigger generation). */
    hasChunk(cx: number, cz: number): boolean {
        return this.chunks.has(chunkKey(cx, cz));
    }

    /** Forget a chunk's block data (used when streaming far chunks out). */
    dropChunk(cx: number, cz: number): void {
        this.chunks.delete(chunkKey(cx, cz));
        // Only drop this chunk's own cached light, NOT its neighbours'. Terrain
        // regenerates deterministically (block data is identical on reload, and
        // player edits re-heal via invalidateEdit), so neighbouring light caches
        // stay valid. Invalidating the full 3x3 here forced ~8 needless full-region
        // light re-floods for every chunk that streamed out as the player moved —
        // the dominant per-frame cost. Self-only invalidation keeps the light cache
        // bounded to roughly the loaded chunk set while eliminating that churn.
        this.light.invalidate(cx, cz);
    }

    getBlock(wx: number, wy: number, wz: number): Block {
        if (wy < 0 || wy >= WORLD_H) return Block.AIR;
        const cx = Math.floor(wx / CHUNK_SX);
        const cz = Math.floor(wz / CHUNK_SZ);
        const lx = wx - cx * CHUNK_SX;
        const lz = wz - cz * CHUNK_SZ;
        return this.getChunk(cx, cz).blocks[blockIndex(lx, wy, lz)] as Block;
    }

    /** Packed (sky<<4 | block) voxel light at a world cell. */
    getLightPacked(wx: number, wy: number, wz: number): number {
        return this.light.getPacked(wx, wy, wz);
    }

    /** Set a block. Returns the affected chunk coords, or null if out of range.
     *  `record` (default true) also stores the change as a persistent player edit;
     *  pass false for simulation writes (e.g. water flooding) that re-derive on
     *  reload and would otherwise bloat the save with regenerable cells. */
    setBlock(wx: number, wy: number, wz: number, id: Block, record = true): { cx: number; cz: number } | null {
        if (wy < 0 || wy >= WORLD_H) return null;
        const cx = Math.floor(wx / CHUNK_SX);
        const cz = Math.floor(wz / CHUNK_SZ);
        const lx = wx - cx * CHUNK_SX;
        const lz = wz - cz * CHUNK_SZ;
        this.getChunk(cx, cz).blocks[blockIndex(lx, wy, lz)] = id;
        if (record) this.recordEdit(cx, cz, blockIndex(lx, wy, lz), id);
        // Border-aware light invalidation: always the edited chunk, and a neighbour
        // only when the edit is on the shared seam. Dropping all 8 neighbour light
        // caches per edit forced a full 3x3 light re-flood for each on the next
        // mesh read, which made digging hitch badly.
        this.light.invalidateEdit(wx, wz);
        return { cx, cz };
    }

    private recordEdit(cx: number, cz: number, idx: number, id: number): void {
        if (blockLight(id) > 0) this._anyEmitters = true;
        const key = chunkKey(cx, cz);
        let e = this.edits.get(key);
        if (!e) {
            e = new Map();
            this.edits.set(key, e);
        }
        e.set(idx, id);
    }

    /** Serialise player edits as a flat [wx, wy, wz, id, ...] array (deltas only). */
    exportEdits(): number[] {
        const out: number[] = [];
        for (const [key, e] of this.edits) {
            const comma = key.indexOf(",");
            const cx = parseInt(key.slice(0, comma), 10);
            const cz = parseInt(key.slice(comma + 1), 10);
            for (const [idx, id] of e) {
                const lx = idx % CHUNK_SX;
                const r = (idx - lx) / CHUNK_SX;
                const lz = r % CHUNK_SZ;
                const wy = (r - lz) / CHUNK_SZ;
                out.push(cx * CHUNK_SX + lx, wy, cz * CHUNK_SZ + lz, id);
            }
        }
        return out;
    }

    /** Reset to a new seed + player-edit set (used when loading a save). Clears all
     *  cached chunks and light; the caller must rebuild any chunk meshes afterwards. */
    reset(seed: number, edits: number[]): void {
        this.seed = seed;
        this.chunks.clear();
        this.edits.clear();
        this._anyEmitters = false;
        this.light.clear();
        for (let i = 0; i + 3 < edits.length; i += 4) {
            const wx = edits[i]!;
            const wy = edits[i + 1]!;
            const wz = edits[i + 2]!;
            const id = edits[i + 3]!;
            if (wy < 0 || wy >= WORLD_H) continue;
            const cx = Math.floor(wx / CHUNK_SX);
            const cz = Math.floor(wz / CHUNK_SZ);
            const lx = wx - cx * CHUNK_SX;
            const lz = wz - cz * CHUNK_SZ;
            this.recordEdit(cx, cz, blockIndex(lx, wy, lz), id);
        }
    }

    /** Topmost non-air block Y in a column (for spawn placement). -1 if empty. */
    surfaceY(wx: number, wz: number): number {
        for (let y = WORLD_H - 1; y >= 0; y--) {
            if (this.getBlock(wx, y, wz) !== Block.AIR) return y;
        }
        return -1;
    }

    /**
     * Find a safe surface spawn near (wx,wz): a column whose top block is solid
     * ground (never a tree, water or cactus) with two blocks of clear air above
     * so the player never spawns inside foliage. Spirals outward for a clear
     * column and returns the centred feet position.
     */
    findSpawn(wx: number, wz: number): { x: number; y: number; z: number } {
        const blocked = (b: Block): boolean =>
            b === Block.LOG || b === Block.LEAVES || b === Block.WATER || b === Block.CACTUS || b === Block.AIR;
        for (let r = 0; r <= 24; r++) {
            for (let dz = -r; dz <= r; dz++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // current ring only
                    const cx = wx + dx;
                    const cz = wz + dz;
                    const top = this.surfaceY(cx, cz);
                    if (top < 0) continue;
                    if (blocked(this.getBlock(cx, top, cz))) continue;
                    if (this.getBlock(cx, top + 1, cz) !== Block.AIR) continue;
                    if (this.getBlock(cx, top + 2, cz) !== Block.AIR) continue;
                    return { x: cx + 0.5, y: top + 1, z: cz + 0.5 };
                }
            }
        }
        const fy = this.surfaceY(wx, wz);
        return { x: wx + 0.5, y: (fy >= 0 ? fy : 40) + 1, z: wz + 0.5 };
    }
}
