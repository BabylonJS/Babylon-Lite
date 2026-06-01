// Minecraft-style voxel light propagation. Two independent channels per cell,
// each 0..15, packed into one byte as (skylight << 4) | blocklight:
//   - skylight: comes from the open sky, full strength straight down, attenuating
//     by 1 per block horizontally/upward, so digging under cover gets darker.
//   - blocklight: emitted by glowing blocks (e.g. glowstone), attenuating 1/block.
//
// Light for a chunk is computed self-contained from raw blocks over the chunk plus
// a one-chunk (16-block) margin on X/Z. Because the max propagation distance (15)
// is < the margin, each chunk's light is fully correct and independent of any
// neighbour's *light* — only neighbour *blocks* are read — so there are no ordering
// or seam artifacts. Results are cached per chunk and invalidated on edits / unload.

import { CHUNK_SX, CHUNK_SZ, WORLD_H, blockIndex, chunkKey } from "./constants.js";
import { Block, blockLight, lightOpaque } from "./blocks.js";
import type { World } from "./world.js";

const MAX_LIGHT = 15;

// Working region = the 3x3 chunk block of (cx,cz): a 16-block margin each side.
const RW = CHUNK_SX * 3;
const RD = CHUNK_SZ * 3;
const REGION_CELLS = RW * RD * WORLD_H;
const CHUNK_CELLS = CHUNK_SX * CHUNK_SZ * WORLD_H;

/** Region linear index. rx in [0,RW), rz in [0,RD), ry in [0,WORLD_H). */
function ri(rx: number, ry: number, rz: number): number {
    return (ry * RD + rz) * RW + rx;
}

export class WorldLight {
    private readonly world: World;
    private readonly cache = new Map<string, Uint8Array>();

    // Reused scratch buffers (one region's worth) so compute() allocates nothing.
    private readonly sky = new Uint8Array(REGION_CELLS);
    private readonly blk = new Uint8Array(REGION_CELLS);
    private readonly region: Uint8Array[] = new Array(9);
    // Per-column open-sky floor: ry of the lowest cell still open to the sky (one
    // above the highest light-opaque block). Cells at/above this in the column are
    // full skylight; used to enqueue only shadow-boundary cells into the BFS.
    private readonly floor = new Int16Array(RW * RD);
    private q = new Int32Array(1 << 16);

    // Per-frame budget tracking. compute() is expensive (a full 3x3 region flood),
    // and meshing one cold chunk reads light 1 block past its border, cascading a
    // compute for that chunk AND its 8 neighbours — up to 9 floods in one frame.
    // warmFor() caps how many run per frame so that burst is spread over a few
    // frames instead of stalling one.
    private frameComputes = 0;

    constructor(world: World) {
        this.world = world;
    }

    /** Reset the per-frame compute budget. Call once at the start of each frame's
     *  chunk-build pass (before warmFor). */
    beginFrame(): void {
        this.frameComputes = 0;
    }

    /** Ensure the 3x3 light neighbourhood around chunk (cx,cz) is cached, so a mesh
     *  build of that chunk reads only cache hits (no synchronous compute mid-build).
     *  Computes missing regions until `maxComputes` floods have run this frame, then
     *  returns false without finishing so the caller can defer the build a frame and
     *  spread the cost. Returns true once the whole neighbourhood is ready. */
    warmFor(cx: number, cz: number, maxComputes: number): boolean {
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const key = chunkKey(cx + dx, cz + dz);
                if (this.cache.has(key)) continue;
                if (this.frameComputes >= maxComputes) return false;
                this.cache.set(key, this.compute(cx + dx, cz + dz));
                this.frameComputes++;
            }
        }
        return true;
    }

    /** Packed (sky<<4 | block) light at a world cell. Above the world = full sky. */
    getPacked(wx: number, wy: number, wz: number): number {
        if (wy >= WORLD_H) return MAX_LIGHT << 4;
        if (wy < 0) return 0;
        const cx = Math.floor(wx / CHUNK_SX);
        const cz = Math.floor(wz / CHUNK_SZ);
        const arr = this.ensure(cx, cz);
        const lx = wx - cx * CHUNK_SX;
        const lz = wz - cz * CHUNK_SZ;
        return arr[blockIndex(lx, wy, lz)]!;
    }

    /** Drop the cached light for a single chunk. */
    invalidate(cx: number, cz: number): void {
        this.cache.delete(chunkKey(cx, cz));
    }

    /** Drop all cached light (used when reloading the world). */
    clear(): void {
        this.cache.clear();
    }

    /** Drop cached light for a chunk and its 8 neighbours (an edit reaches <=15
     *  blocks, i.e. at most into the immediately adjacent chunks). */
    invalidateAround(cx: number, cz: number): void {
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) this.cache.delete(chunkKey(cx + dx, cz + dz));
        }
    }

    /** Invalidate light for a single-block edit at world XZ: always the edited
     *  chunk, plus a neighbour only when the edit sits on the shared border (where
     *  its near-seam light changes most). Interior edits deliberately KEEP the
     *  neighbour caches: those chunks aren't remeshed for an interior edit, and
     *  recomputing a full 3x3 light region for all 8 neighbours on every block dug
     *  was the dominant cost. Neighbours self-heal whenever they next remesh. */
    invalidateEdit(wx: number, wz: number): void {
        const cx = Math.floor(wx / CHUNK_SX);
        const cz = Math.floor(wz / CHUNK_SZ);
        this.cache.delete(chunkKey(cx, cz));
        const lx = wx - cx * CHUNK_SX;
        const lz = wz - cz * CHUNK_SZ;
        const nx = lx === 0 ? -1 : lx === CHUNK_SX - 1 ? 1 : 0;
        const nz = lz === 0 ? -1 : lz === CHUNK_SZ - 1 ? 1 : 0;
        if (nx) this.cache.delete(chunkKey(cx + nx, cz));
        if (nz) this.cache.delete(chunkKey(cx, cz + nz));
        if (nx && nz) this.cache.delete(chunkKey(cx + nx, cz + nz));
    }

    private ensure(cx: number, cz: number): Uint8Array {
        const key = chunkKey(cx, cz);
        let arr = this.cache.get(key);
        if (!arr) {
            arr = this.compute(cx, cz);
            this.cache.set(key, arr);
        }
        return arr;
    }

    private push(head: number, value: number): number {
        if (head >= this.q.length) {
            const bigger = new Int32Array(this.q.length * 2);
            bigger.set(this.q);
            this.q = bigger;
        }
        this.q[head] = value;
        return head + 1;
    }

    private compute(cx: number, cz: number): Uint8Array {
        const sky = this.sky;
        const blk = this.blk;
        const hasEmitters = this.world.anyEmitters;
        sky.fill(0);
        if (hasEmitters) blk.fill(0);

        // Gather the 3x3 block arrays so cell reads are direct (no map lookups).
        const region = this.region;
        for (let gz = 0; gz < 3; gz++) {
            for (let gx = 0; gx < 3; gx++) {
                region[gz * 3 + gx] = this.world.getChunk(cx - 1 + gx, cz - 1 + gz).blocks;
            }
        }
        const blockAt = (rx: number, ry: number, rz: number): Block => {
            const gx = rx >> 4;
            const gz = rz >> 4;
            return region[gz * 3 + gx]![blockIndex(rx & 15, ry, rz & 15)] as Block;
        };

        // --- Pass A: per-column open-sky floor (one above the topmost opaque block).
        // Worldgen blocks never emit light, so this top-down scan early-breaks at the
        // first opaque cell instead of walking the whole 96-tall column. ---
        const floor = this.floor;
        for (let rz = 0; rz < RD; rz++) {
            for (let rx = 0; rx < RW; rx++) {
                let f = 0;
                for (let ry = WORLD_H - 1; ry >= 0; ry--) {
                    if (lightOpaque(blockAt(rx, ry, rz))) {
                        f = ry + 1;
                        break;
                    }
                }
                floor[rz * RW + rx] = f;
            }
        }

        // --- Pass B: skylight. Every cell at/above its column floor is full skylight,
        // so set those to MAX directly. Only ENQUEUE a cell as a BFS source when it
        // borders a higher-floor (shadowed) neighbour column — i.e. it sits at a
        // terrain edge where light flows sideways into shade. Interior plateau cells
        // are surrounded by MAX and never propagate anything new, so skipping them
        // shrinks the BFS frontier from "all open air" to a thin surface shell. ---
        let skyHead = 0;
        for (let rz = 0; rz < RD; rz++) {
            for (let rx = 0; rx < RW; rx++) {
                const base = rz * RW + rx;
                const f = floor[base]!;
                const fW = rx > 0 ? floor[base - 1]! : f;
                const fE = rx < RW - 1 ? floor[base + 1]! : f;
                const fN = rz > 0 ? floor[base - RW]! : f;
                const fS = rz < RD - 1 ? floor[base + RW]! : f;
                const maxAdj = Math.max(fW, fE, fN, fS);
                for (let ry = WORLD_H - 1; ry >= f; ry--) {
                    const i = ri(rx, ry, rz);
                    sky[i] = MAX_LIGHT;
                    // Exposed iff some horizontal neighbour's floor is above this cell.
                    if (ry < maxAdj) skyHead = this.push(skyHead, i);
                }
            }
        }

        // --- Blocklight emitters (only player-placed glowstone, so skip entirely
        // until one has been placed). Full-column scan since emitters can sit at any
        // depth. ---
        let blkHead = 0;
        if (hasEmitters) {
            for (let rz = 0; rz < RD; rz++) {
                for (let rx = 0; rx < RW; rx++) {
                    for (let ry = WORLD_H - 1; ry >= 0; ry--) {
                        const e = blockLight(blockAt(rx, ry, rz));
                        if (e > 0) {
                            const i = ri(rx, ry, rz);
                            blk[i] = e;
                            blkHead = this.pushBlk(blkHead, i);
                        }
                    }
                }
            }
        }

        this.bfs(sky, skyHead, blockAt, true);
        if (hasEmitters) this.bfsBlk(blk, blkHead, blockAt);

        // --- Pack the centre chunk's slice into the output. ---
        const out = new Uint8Array(CHUNK_CELLS);
        for (let y = 0; y < WORLD_H; y++) {
            for (let lz = 0; lz < CHUNK_SZ; lz++) {
                for (let lx = 0; lx < CHUNK_SX; lx++) {
                    const i = ri(lx + CHUNK_SX, y, lz + CHUNK_SZ);
                    out[blockIndex(lx, y, lz)] = (sky[i]! << 4) | blk[i]!;
                }
            }
        }
        return out;
    }

    // Separate queue for blocklight so the two BFS passes don't interfere.
    private qb = new Int32Array(1 << 12);
    private pushBlk(head: number, value: number): number {
        if (head >= this.qb.length) {
            const bigger = new Int32Array(this.qb.length * 2);
            bigger.set(this.qb);
            this.qb = bigger;
        }
        this.qb[head] = value;
        return head + 1;
    }

    /** Flood-fill skylight. `vertical` enables the no-attenuation straight-down rule. */
    private bfs(buf: Uint8Array, tail: number, blockAt: (x: number, y: number, z: number) => Block, vertical: boolean): void {
        // this.q may be reallocated by push(); always index through this.q.
        for (let head = 0; head < tail; head++) {
            const i = this.q[head]!;
            const L = buf[i]!;
            if (L <= 1) continue;
            const rx = i % RW;
            const t = (i / RW) | 0;
            const rz = t % RD;
            const ry = (t / RD) | 0;
            // -Y (straight down): skylight at full strength keeps its value.
            if (ry > 0) tail = this.spread(buf, blockAt, rx, ry - 1, rz, vertical && L === MAX_LIGHT ? L : L - 1, tail);
            if (ry < WORLD_H - 1) tail = this.spread(buf, blockAt, rx, ry + 1, rz, L - 1, tail);
            if (rx > 0) tail = this.spread(buf, blockAt, rx - 1, ry, rz, L - 1, tail);
            if (rx < RW - 1) tail = this.spread(buf, blockAt, rx + 1, ry, rz, L - 1, tail);
            if (rz > 0) tail = this.spread(buf, blockAt, rx, ry, rz - 1, L - 1, tail);
            if (rz < RD - 1) tail = this.spread(buf, blockAt, rx, ry, rz + 1, L - 1, tail);
        }
    }

    private spread(buf: Uint8Array, blockAt: (x: number, y: number, z: number) => Block, rx: number, ry: number, rz: number, level: number, tail: number): number {
        if (level <= 0) return tail;
        if (lightOpaque(blockAt(rx, ry, rz))) return tail;
        const i = ri(rx, ry, rz);
        if (buf[i]! >= level) return tail;
        buf[i] = level;
        return this.push(tail, i);
    }

    /** Flood-fill blocklight (uniform 1/block attenuation, all 6 directions). */
    private bfsBlk(buf: Uint8Array, tail: number, blockAt: (x: number, y: number, z: number) => Block): void {
        for (let head = 0; head < tail; head++) {
            const i = this.qb[head]!;
            const L = buf[i]!;
            if (L <= 1) continue;
            const rx = i % RW;
            const t = (i / RW) | 0;
            const rz = t % RD;
            const ry = (t / RD) | 0;
            const n = L - 1;
            if (ry > 0) tail = this.spreadBlk(buf, blockAt, rx, ry - 1, rz, n, tail);
            if (ry < WORLD_H - 1) tail = this.spreadBlk(buf, blockAt, rx, ry + 1, rz, n, tail);
            if (rx > 0) tail = this.spreadBlk(buf, blockAt, rx - 1, ry, rz, n, tail);
            if (rx < RW - 1) tail = this.spreadBlk(buf, blockAt, rx + 1, ry, rz, n, tail);
            if (rz > 0) tail = this.spreadBlk(buf, blockAt, rx, ry, rz - 1, n, tail);
            if (rz < RD - 1) tail = this.spreadBlk(buf, blockAt, rx, ry, rz + 1, n, tail);
        }
    }

    private spreadBlk(buf: Uint8Array, blockAt: (x: number, y: number, z: number) => Block, rx: number, ry: number, rz: number, level: number, tail: number): number {
        if (level <= 0) return tail;
        if (lightOpaque(blockAt(rx, ry, rz))) return tail;
        const i = ri(rx, ry, rz);
        if (buf[i]! >= level) return tail;
        buf[i] = level;
        return this.pushBlk(tail, i);
    }
}

export { MAX_LIGHT };
