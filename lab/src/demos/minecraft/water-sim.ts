// Flowing-water simulation. Water behaves as an incompressible fluid that seeks
// equilibrium: it falls straight down into any air below it, and below the global
// sea level it also spreads sideways, so digging into or beneath a lake or ocean
// makes the water pour in and flood the opening. Placed water (creative) streams
// downward like a waterfall until it lands.
//
// The simulation is event-driven, generational and bounded, mirroring the
// falling-block system:
//   - Edits (break/place) enqueue the affected cell and its six neighbours.
//   - Flow advances on fixed timed STEPS (not per frame): each step evaluates one
//     generation of cells, and the cells it produces are deferred to the NEXT step.
//     So an AIR cell fed from a water source (from above always, or from the side
//     only below sea level) turns to water, and its neighbours flow one step later
//     — the flood visibly creeps in one block-ring at a time, like Minecraft.
//   - Horizontal spread is gated to below sea level, so flooding is always bounded
//     by solid walls and the sea surface and never runs away across the world.
//   - Touched chunks are coalesced and each remeshed at most once per frame.
//   - Startup (prefill) drains every generation to a fixpoint instantly, so the
//     initial world loads with its oceans already settled (no step-in delay).
//
// Pure public-API: only world block access and the renderer's remesh entry point.

import { Block } from "./blocks.js";
import { CHUNK_SX, CHUNK_SZ, SEA_LEVEL, WORLD_H } from "./constants.js";
import type { World } from "./world.js";
import type { ChunkRenderer } from "./chunk-renderer.js";

// Water advances one "ring" of cells per fixed step, so a flood visibly creeps in
// block by block (à la Minecraft) instead of filling instantly. Cells produced by a
// step are deferred to the NEXT step, so each generation is one block farther out.
const WATER_STEP = 0.2; // seconds between flow steps
const MAX_STEPS_PER_FRAME = 4; // catch-up cap so a long stall can't spiral
const MAX_CELLS_PER_STEP = 8192; // safety bound on a single (huge) generation

export class WaterSim {
    private readonly world: World;
    private readonly renderer: ChunkRenderer;
    private current: number[] = []; // generation being evaluated this step
    private next: number[] = []; // cells produced this step, evaluated next step
    private head = 0; // read cursor into `current`
    private accum = 0; // seconds accumulated toward the next step
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
        this.current = [];
        this.next = [];
        this.head = 0;
        this.accum = 0;
        this.pending.clear();
    }

    /** A block was placed at (x,y,z): a placed water source spreads; a solid block
     *  placed in water just re-checks its surroundings. */
    onPlace(x: number, y: number, z: number): void {
        this.enqueueNeighborhood(x, y, z);
    }

    /** Visit every sub-sea-level air cell in a chunk that already touches water —
     *  the flood front a freshly generated chunk introduces. Worldgen fills the
     *  ocean body straight down per column, but a cave that opens into the seafloor
     *  has lateral air the column fill can't reach (a "wall of water" beside a dry
     *  pocket); these are the cells from which water must pour through the connected
     *  cavity. */
    private forEachFloodSeed(cx: number, cz: number, visit: (x: number, y: number, z: number) => void): void {
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
                        visit(wx, y, wz);
                    }
                }
            }
        }
    }

    /** Seed flooding for a chunk into the live stepwise generations (used only by
     *  prefill, which then drains them instantly). */
    seedChunk(cx: number, cz: number): void {
        this.forEachFloodSeed(cx, cz, (x, y, z) => this.enqueue(x, y, z));
    }

    /** Instantly settle the flooding a freshly activated chunk introduces, with one
     *  remesh per touched chunk. World-gen oceans thus never visibly "creep" in as
     *  you explore — only player edits flow step by step. Self-contained: it runs
     *  its own flood and does NOT touch the live stepwise generations. */
    settleChunk(cx: number, cz: number): void {
        const q: number[] = [];
        const seen = new Set<string>();
        const push = (x: number, y: number, z: number): void => {
            if (y < 0 || y >= WORLD_H) return;
            if (!this.world.hasChunk(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ))) return;
            const k = x + "," + y + "," + z;
            if (seen.has(k)) return;
            seen.add(k);
            q.push(x, y, z);
        };
        this.forEachFloodSeed(cx, cz, push);
        if (q.length === 0) return;
        const dirty = new Set<string>();
        let i = 0;
        let guard = 0;
        const MAX = 4_000_000;
        while (i < q.length && guard++ < MAX) {
            const x = q[i]!;
            const y = q[i + 1]!;
            const z = q[i + 2]!;
            i += 3;
            // Allow a cell to be reconsidered if a later fill reaches it (a cell
            // popped before its feeder fills would otherwise be lost).
            seen.delete(x + "," + y + "," + z);
            if (this.feeds(x, y, z)) {
                this.world.setBlock(x, y, z, Block.WATER, false);
                this.markDirty(x, z, dirty);
                push(x, y - 1, z);
                push(x + 1, y, z);
                push(x - 1, y, z);
                push(x, y, z + 1);
                push(x, y, z - 1);
            }
        }
        this.flush(dirty);
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
        this.next.push(x, y, z);
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
        // Drain BOTH generations to a fixpoint with no step delay: startup water is
        // already settled before the first frame is meshed.
        while ((this.head < this.current.length || this.next.length > 0) && guard++ < MAX) {
            if (this.head >= this.current.length) this.promote();
            const x = this.current[this.head]!;
            const y = this.current[this.head + 1]!;
            const z = this.current[this.head + 2]!;
            this.head += 3;
            this.pending.delete(x + "," + y + "," + z);
            this.evaluate(x, y, z, sink);
        }
        // Reset so the live per-step loop starts clean.
        this.current.length = 0;
        this.next.length = 0;
        this.head = 0;
        this.accum = 0;
        this.pending.clear();
    }

    /** True when no flow work remains in either generation. */
    private idle(): boolean {
        return this.head >= this.current.length && this.next.length === 0;
    }

    /** Swap the produced `next` generation into `current` and clear `next`. */
    private promote(): void {
        this.head = 0;
        const tmp = this.current;
        this.current = this.next;
        this.next = tmp;
        this.next.length = 0;
    }

    /** Advance the flood on fixed steps so it creeps one block-ring at a time. The
     *  per-frame delta only triggers a whole number of steps; the remainder carries
     *  over, keeping the flow rate independent of frame rate. */
    update(dt: number): void {
        if (this.idle()) {
            this.accum = 0;
            return;
        }
        this.accum += dt;
        const dirty = new Set<string>();
        let steps = 0;
        while (this.accum >= WATER_STEP && steps < MAX_STEPS_PER_FRAME) {
            this.accum -= WATER_STEP;
            steps++;
            this.step(dirty);
            if (this.idle()) {
                this.accum = 0;
                break;
            }
        }
        this.flush(dirty);
    }

    /** Evaluate exactly one generation: every cell currently in `current`. This is
     *  TWO-PHASE so the spread is strictly one block-ring per step: we first decide
     *  which cells fill — reading the world as it was at the start of the generation
     *  — and only THEN apply the water and enqueue neighbours (into `next`). Applying
     *  mid-scan would let a cell filled earlier in the generation feed its sibling,
     *  collapsing several rings into one step. A single enormous generation is
     *  bounded by MAX_CELLS_PER_STEP and carries its tail to the next step. */
    private step(dirty: Set<string>): void {
        if (this.head >= this.current.length) {
            if (this.next.length === 0) return;
            this.promote();
        }
        // Phase 1: collect cells that fill this generation (no world mutation yet).
        const fills: number[] = [];
        let processed = 0;
        while (this.head < this.current.length && processed < MAX_CELLS_PER_STEP) {
            const x = this.current[this.head]!;
            const y = this.current[this.head + 1]!;
            const z = this.current[this.head + 2]!;
            this.head += 3;
            this.pending.delete(x + "," + y + "," + z);
            processed++;
            if (this.feeds(x, y, z)) fills.push(x, y, z);
        }
        // Compact the consumed prefix so a carried-over generation can't grow the
        // backing array unbounded.
        if (this.head >= this.current.length) {
            this.current.length = 0;
            this.head = 0;
        } else if (this.head > 4096) {
            this.current = this.current.slice(this.head);
            this.head = 0;
        }
        // Phase 2: apply the fills and schedule their neighbours for the next step.
        for (let i = 0; i < fills.length; i += 3) {
            this.fill(fills[i]!, fills[i + 1]!, fills[i + 2]!, dirty);
        }
    }

    /** True if the AIR cell at (x,y,z) is currently fed by water: from above always
     *  (water falls), or — only below sea level — from any of the four sides. Pure:
     *  it reads the world but never mutates it. */
    private feeds(x: number, y: number, z: number): boolean {
        if (this.world.getBlock(x, y, z) !== Block.AIR) return false;
        if (this.world.getBlock(x, y + 1, z) === Block.WATER) return true;
        if (y < SEA_LEVEL) {
            return (
                this.world.getBlock(x + 1, y, z) === Block.WATER ||
                this.world.getBlock(x - 1, y, z) === Block.WATER ||
                this.world.getBlock(x, y, z + 1) === Block.WATER ||
                this.world.getBlock(x, y, z - 1) === Block.WATER
            );
        }
        return false;
    }

    /** Turn a fed cell into water, mark its chunk(s) dirty, and enqueue its down +
     *  four lateral neighbours so the flood continues. */
    private fill(x: number, y: number, z: number, dirty: Set<string>): void {
        this.world.setBlock(x, y, z, Block.WATER, false);
        this.markDirty(x, z, dirty);
        this.enqueue(x, y - 1, z);
        this.enqueue(x + 1, y, z);
        this.enqueue(x - 1, y, z);
        this.enqueue(x, y, z + 1);
        this.enqueue(x, y, z - 1);
    }

    /** Immediate evaluate-and-apply for the instant warm-up paths (prefill /
     *  settleChunk), where there is no per-step delay. */
    private evaluate(x: number, y: number, z: number, dirty: Set<string>): void {
        if (this.feeds(x, y, z)) this.fill(x, y, z, dirty);
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
