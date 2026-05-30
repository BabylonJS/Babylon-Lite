// Flowing-water simulation. Water behaves as an incompressible fluid that seeks
// equilibrium: it falls straight down into any air below it, and below the global
// sea level it also spreads sideways, so digging into or beneath a lake or ocean
// makes the water pour in and flood the opening. Placed water (creative) streams
// downward like a waterfall until it lands.
//
// The simulation is event-driven and bounded, mirroring the falling-block system:
//   - Edits (break/place) enqueue the affected cell and its six neighbours.
//   - Each frame a capped number of cells are evaluated; an AIR cell that is fed
//     from a water source (from above always, or from the side only below sea
//     level) becomes water and enqueues its neighbours, so a flood spreads over a
//     few frames — which reads naturally as the water flowing in.
//   - Horizontal spread is gated to below sea level, so flooding is always bounded
//     by solid walls and the sea surface and never runs away across the world.
//   - Touched chunks are coalesced and each remeshed at most once per frame.
//
// Pure public-API: only world block access and the renderer's remesh entry point.

import { Block } from "./blocks.js";
import { CHUNK_SX, CHUNK_SZ, SEA_LEVEL, WORLD_H } from "./constants.js";
import type { World } from "./world.js";
import type { ChunkRenderer } from "./chunk-renderer.js";

const MAX_CELLS_PER_FRAME = 768;

export class WaterSim {
    private readonly world: World;
    private readonly renderer: ChunkRenderer;
    private queue: number[] = []; // flat triples [x,y,z, x,y,z, ...]
    private head = 0; // read cursor into queue
    private readonly pending = new Set<string>();

    constructor(world: World, renderer: ChunkRenderer) {
        this.world = world;
        this.renderer = renderer;
    }

    /** A block was broken at (x,y,z): water may now flow into the new opening. */
    onBreak(x: number, y: number, z: number): void {
        this.enqueueNeighborhood(x, y, z);
    }

    /** Clear all pending flow work (used when reloading the world). Flooding then
     *  re-seeds deterministically as chunks reactivate. */
    reset(): void {
        this.queue = [];
        this.head = 0;
        this.pending.clear();
    }

    /** A block was placed at (x,y,z): a placed water source spreads; a solid block
     *  placed in water just re-checks its surroundings. */
    onPlace(x: number, y: number, z: number): void {
        this.enqueueNeighborhood(x, y, z);
    }

    /** Seed flooding for a freshly generated/activated chunk. Worldgen fills the
     *  ocean body straight down per column, but a cave that opens into the seafloor
     *  has lateral air the column fill can't reach — leaving a "wall of water" with
     *  a dry pocket beside it. We enqueue every sub-sea-level air cell that already
     *  touches water (the flood front); evaluate() then pours water through the
     *  connected cavity (across chunk borders) until the cave is full. Sealed
     *  pockets with no air path to the ocean stay dry. */
    seedChunk(cx: number, cz: number): void {
        const baseX = cx * CHUNK_SX;
        const baseZ = cz * CHUNK_SZ;
        for (let lx = 0; lx < CHUNK_SX; lx++) {
            for (let lz = 0; lz < CHUNK_SZ; lz++) {
                const wx = baseX + lx;
                const wz = baseZ + lz;
                for (let y = 1; y < SEA_LEVEL; y++) {
                    if (this.world.getBlock(wx, y, wz) !== Block.AIR) continue;
                    if (
                        this.world.getBlock(wx, y + 1, wz) === Block.WATER ||
                        this.world.getBlock(wx + 1, y, wz) === Block.WATER ||
                        this.world.getBlock(wx - 1, y, wz) === Block.WATER ||
                        this.world.getBlock(wx, y, wz + 1) === Block.WATER ||
                        this.world.getBlock(wx, y, wz - 1) === Block.WATER
                    ) {
                        this.enqueue(wx, y, wz);
                    }
                }
            }
        }
    }

    private enqueueNeighborhood(x: number, y: number, z: number): void {
        this.enqueue(x, y, z);
        this.enqueue(x, y + 1, z);
        this.enqueue(x, y - 1, z);
        this.enqueue(x + 1, y, z);
        this.enqueue(x - 1, y, z);
        this.enqueue(x, y, z + 1);
        this.enqueue(x, y, z - 1);
    }

    private enqueue(x: number, y: number, z: number): void {
        if (y < 0 || y >= WORLD_H) return;
        // Never let the flood pull in brand-new chunks: a long under-sea cavern
        // would otherwise stream (and mutate) chunks far beyond the render radius.
        // Cells just past the loaded edge are picked up by seedChunk when their
        // chunk activates, so the flood resumes seamlessly across the boundary.
        if (!this.world.hasChunk(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ))) return;
        const k = x + "," + y + "," + z;
        if (this.pending.has(k)) return;
        this.pending.add(k);
        this.queue.push(x, y, z);
    }

    /** One-shot, data-only flood for startup. Seeds the given chunks then pours
     *  water through every connected sub-sea cavity to a fixpoint WITHOUT remeshing
     *  — the caller meshes afterwards, so each chunk is built exactly once with its
     *  water already in place (no first-frame "dry cave" pop, no remesh storm). */
    prefill(chunks: ReadonlyArray<readonly [number, number]>): void {
        for (const c of chunks) this.seedChunk(c[0], c[1]);
        const sink = new Set<string>(); // discarded: no remesh during warm-up
        let guard = 0;
        const MAX = 4_000_000;
        while (this.head < this.queue.length && guard++ < MAX) {
            const x = this.queue[this.head]!;
            const y = this.queue[this.head + 1]!;
            const z = this.queue[this.head + 2]!;
            this.head += 3;
            this.pending.delete(x + "," + y + "," + z);
            this.evaluate(x, y, z, sink);
        }
        // Reset so the live per-frame loop starts from a clean queue.
        this.queue.length = 0;
        this.head = 0;
        this.pending.clear();
    }

    /** Advance the flood a bounded amount; the remainder carries to later frames. */
    update(): void {
        if (this.head >= this.queue.length) {
            if (this.queue.length > 0) {
                this.queue.length = 0;
                this.head = 0;
            }
            return;
        }
        const dirty = new Set<string>();
        let processed = 0;
        while (this.head < this.queue.length && processed < MAX_CELLS_PER_FRAME) {
            const x = this.queue[this.head]!;
            const y = this.queue[this.head + 1]!;
            const z = this.queue[this.head + 2]!;
            this.head += 3;
            this.pending.delete(x + "," + y + "," + z);
            processed++;
            this.evaluate(x, y, z, dirty);
        }
        // Compact the consumed prefix so the backing array can't grow unbounded.
        if (this.head >= this.queue.length) {
            this.queue.length = 0;
            this.head = 0;
        } else if (this.head > 4096) {
            this.queue = this.queue.slice(this.head);
            this.head = 0;
        }
        this.flush(dirty);
    }

    private evaluate(x: number, y: number, z: number, dirty: Set<string>): void {
        if (this.world.getBlock(x, y, z) !== Block.AIR) return;

        // Fed from above (water always falls) or, below sea level, from any side.
        const fedAbove = this.world.getBlock(x, y + 1, z) === Block.WATER;
        let fedSide = false;
        if (y < SEA_LEVEL) {
            fedSide =
                this.world.getBlock(x + 1, y, z) === Block.WATER ||
                this.world.getBlock(x - 1, y, z) === Block.WATER ||
                this.world.getBlock(x, y, z + 1) === Block.WATER ||
                this.world.getBlock(x, y, z - 1) === Block.WATER;
        }
        if (!fedAbove && !fedSide) return;

        this.world.setBlock(x, y, z, Block.WATER, false);
        this.markDirty(x, z, dirty);

        // Propagate: down first (fall), then outward.
        this.enqueue(x, y - 1, z);
        this.enqueue(x + 1, y, z);
        this.enqueue(x - 1, y, z);
        this.enqueue(x, y, z + 1);
        this.enqueue(x, y, z - 1);
    }

    /** Mark the edited cell's chunk dirty, plus a neighbour chunk only when the
     *  cell lies on the shared border (so that chunk's culled border faces are
     *  rebuilt). Interior cells touch a single chunk, so a spreading flood does
     *  not trigger a 9x full-chunk greedy remesh per filled cell. */
    private markDirty(wx: number, wz: number, dirty: Set<string>): void {
        const cx = Math.floor(wx / CHUNK_SX);
        const cz = Math.floor(wz / CHUNK_SZ);
        const lx = wx - cx * CHUNK_SX;
        const lz = wz - cz * CHUNK_SZ;
        const nx = lx === 0 ? -1 : lx === CHUNK_SX - 1 ? 1 : 0;
        const nz = lz === 0 ? -1 : lz === CHUNK_SZ - 1 ? 1 : 0;
        const xs = nx === 0 ? [0] : [0, nx];
        const zs = nz === 0 ? [0] : [0, nz];
        for (const dz of zs) for (const dx of xs) dirty.add(cx + dx + "," + (cz + dz));
    }

    private flush(dirty: Set<string>): void {
        for (const key of dirty) {
            const [cx, cz] = key.split(",").map(Number);
            this.renderer.remeshIfActive(cx!, cz!);
        }
    }
}
