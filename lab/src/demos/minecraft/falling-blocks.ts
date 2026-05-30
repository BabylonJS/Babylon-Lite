// Falling-block physics for sand and gravel. When such a block loses its support
// (the cell below becomes non-collidable after an edit, or it is placed in mid-air)
// it detaches into a lightweight falling entity: a single textured cube that
// integrates gravity and, on landing, becomes a real block again — cascading so a
// whole column collapses naturally.
//
// Design notes (hardened against the usual voxel-falling pitfalls):
//   - Landing height is found by scanning down to the first collidable cell, so a
//     large per-frame drop can never tunnel through terrain.
//   - The target cell is re-validated (and searched upward) right before placement,
//     so two entities collapsing in lockstep can never overwrite the same cell.
//   - Entities are stepped lowest-first and each landing writes its block
//     immediately, so a column stacks correctly within a single frame.
//   - Spawn checks and remeshes are deferred and coalesced: each affected chunk is
//     rebuilt at most once per frame even when an N-tall column falls at once.
//
// Pure public-API: cube geometry uploaded via createMeshFromData, reusing the
// renderer's day-night-lit opaque voxel material. No engine internals.

import { addToScene, createMeshFromData, removeFromScene, type EngineContext, type Mesh, type SceneContext } from "babylon-lite";

import { Block, blockDef } from "./blocks.js";
import { CHUNK_SX, CHUNK_SZ, WORLD_H } from "./constants.js";
import { MAX_LIGHT } from "./world-light.js";
import type { World } from "./world.js";
import type { ChunkRenderer } from "./chunk-renderer.js";
import type { BlockAtlas, TileRect } from "./atlas.js";

const GRAVITY = 26; // blocks/sec^2
const MAX_SPEED = 36; // blocks/sec
const MAX_ACTIVE = 512;
const MAX_CHECKS_PER_FRAME = 1024;

interface FaceSpec {
    n: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
    group: "top" | "side" | "bottom";
}

// Same outward-quad convention as the chunk mesher so winding matches (back-face
// culling on the shared opaque material).
const FACES: FaceSpec[] = [
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], group: "top" },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], group: "bottom" },
    { n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], group: "side" },
    { n: [-1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], group: "side" },
    { n: [0, 0, 1], u: [-1, 0, 0], v: [0, 1, 0], group: "side" },
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], group: "side" },
];

interface Entity {
    id: Block;
    x: number;
    z: number;
    y: number; // current bottom (world Y); the cube occupies [y, y+1)
    vy: number;
    mesh: Mesh;
    done: boolean;
}

/** Blocks affected by gravity. */
function isFalling(id: number): boolean {
    return id === Block.SAND || id === Block.GRAVEL;
}

export class FallingBlocks {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly world: World;
    private readonly renderer: ChunkRenderer;
    private readonly atlas: BlockAtlas;
    private readonly active: Entity[] = [];
    private checks: [number, number, number][] = [];
    private counter = 0;

    constructor(engine: EngineContext, scene: SceneContext, world: World, renderer: ChunkRenderer, atlas: BlockAtlas) {
        this.engine = engine;
        this.scene = scene;
        this.world = world;
        this.renderer = renderer;
        this.atlas = atlas;
    }

    /** A block was broken at (bx,by,bz): the block resting on top may now fall. */
    onBreak(bx: number, by: number, bz: number): void {
        this.checks.push([bx, by + 1, bz]);
    }

    /** Drop all in-flight falling cubes + pending checks (used when reloading). */
    reset(): void {
        for (const e of this.active) removeFromScene(this.scene, e.mesh);
        this.active.length = 0;
        this.checks = [];
    }

    /** A block was placed at (px,py,pz): it may itself fall if unsupported. */
    onPlace(px: number, py: number, pz: number): void {
        this.checks.push([px, py, pz]);
    }

    private collidable(x: number, y: number, z: number): boolean {
        if (y < 0) return true; // world floor
        if (y >= WORLD_H) return false;
        const d = blockDef(this.world.getBlock(x, y, z));
        return !!d && d.collidable;
    }

    /** Process queued spawn checks, detaching unsupported sand/gravel into entities.
     *  Cascades upward within the same frame so an entire column collapses at once. */
    private processChecks(dirty: Set<string>): void {
        let processed = 0;
        while (this.checks.length > 0 && processed < MAX_CHECKS_PER_FRAME && this.active.length < MAX_ACTIVE) {
            const [x, y, z] = this.checks.pop()!;
            processed++;
            if (y < 0 || y >= WORLD_H) continue;
            const id = this.world.getBlock(x, y, z);
            if (!isFalling(id)) continue;
            if (this.collidable(x, y - 1, z)) continue; // still supported

            // Detach: remove the block, spawn a falling cube, and expose the cell
            // above so a stacked column keeps collapsing.
            this.world.setBlock(x, y, z, Block.AIR);
            this.markDirty(x, z, dirty);
            this.spawnEntity(id, x, y, z);
            this.checks.push([x, y + 1, z]);
        }
    }

    private spawnEntity(id: Block, x: number, y: number, z: number): void {
        const packed = this.world.getLightPacked(x, y, z);
        const sky = (packed >> 4) / MAX_LIGHT;
        const blk = (packed & 15) / MAX_LIGHT;
        const mesh = this.buildCube(id, sky, blk);
        mesh.position.x = x;
        mesh.position.y = y;
        mesh.position.z = z;
        addToScene(this.scene, mesh);
        this.active.push({ id, x, z, y, vy: 0, mesh, done: false });
    }

    /** Integrate all active entities (lowest first so columns stack correctly). */
    update(dt: number): void {
        const dirty = new Set<string>();
        this.processChecks(dirty);

        if (this.active.length > 0) {
            this.active.sort((a, b) => a.y - b.y);
            for (const e of this.active) {
                e.vy = Math.min(e.vy + GRAVITY * dt, MAX_SPEED);
                const drop = e.vy * dt;

                // Rest level: scan down to the first collidable cell. This makes a
                // big per-frame drop impossible to tunnel through.
                let c = Math.floor(e.y + 1e-4);
                while (c > 0 && !this.collidable(e.x, c - 1, e.z)) c--;
                const restY = c;

                const nextY = e.y - drop;
                if (nextY <= restY) {
                    this.land(e, restY, dirty);
                } else {
                    e.y = nextY;
                    e.mesh.position.y = nextY;
                }
            }
            this.flush(dirty);
            this.reap();
        } else if (dirty.size > 0) {
            this.flush(dirty);
        }
    }

    private land(e: Entity, restY: number, dirty: Set<string>): void {
        // Re-validate the target cell right before writing: another entity in the
        // same column may have just filled it. Search upward to the first free cell.
        let ty = restY;
        while (ty < WORLD_H && this.collidable(e.x, ty, e.z)) ty++;
        if (ty < WORLD_H) {
            this.world.setBlock(e.x, ty, e.z, e.id);
            this.markDirty(e.x, e.z, dirty);
            // A sand/gravel resting directly above may now need to settle onto this.
            this.checks.push([e.x, ty + 1, e.z]);
        }
        removeFromScene(this.scene, e.mesh);
        e.done = true;
    }

    private reap(): void {
        for (let i = this.active.length - 1; i >= 0; i--) {
            if (this.active[i]!.done) this.active.splice(i, 1);
        }
    }

    /** Mark the edited cell's chunk dirty, plus a neighbour chunk only when the
     *  cell lies on the shared border (so that chunk's culled border faces are
     *  rebuilt). Interior edits touch a single chunk — avoiding the 9x full-chunk
     *  greedy remesh that made a collapsing column hitch. */
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

    /** Rebuild every touched chunk exactly once. */
    private flush(dirty: Set<string>): void {
        for (const key of dirty) {
            const [cx, cz] = key.split(",").map(Number);
            this.renderer.remeshIfActive(cx!, cz!);
        }
    }

    /** Build a 1x1x1 textured cube (local 0..1) with the block's atlas tiles and a
     *  uniform baked light, using the shared day-night-lit opaque material. */
    private buildCube(id: Block, sky: number, blk: number): Mesh {
        const d = blockDef(id)!;
        const pos: number[] = [];
        const nrm: number[] = [];
        const uv: number[] = [];
        const col: number[] = [];
        const idx: number[] = [];
        for (const f of FACES) {
            const rect: TileRect = this.atlas.rects.get(d.faces[f.group]) ?? this.atlas.fallback;
            const base = pos.length / 3;
            const bx = (f.n[0] > 0 ? 1 : 0) + (f.u[0] < 0 ? 1 : 0) + (f.v[0] < 0 ? 1 : 0);
            const by = (f.n[1] > 0 ? 1 : 0) + (f.u[1] < 0 ? 1 : 0) + (f.v[1] < 0 ? 1 : 0);
            const bz = (f.n[2] > 0 ? 1 : 0) + (f.u[2] < 0 ? 1 : 0) + (f.v[2] < 0 ? 1 : 0);
            const uvU = [rect.u0, rect.u1, rect.u1, rect.u0];
            const uvV = [rect.v1, rect.v1, rect.v0, rect.v0];
            for (let c = 0; c < 4; c++) {
                const cu = c === 1 || c === 2 ? 1 : 0;
                const cv = c === 2 || c === 3 ? 1 : 0;
                pos.push(bx + cu * f.u[0] + cv * f.v[0], by + cu * f.u[1] + cv * f.v[1], bz + cu * f.u[2] + cv * f.v[2]);
                nrm.push(f.n[0], f.n[1], f.n[2]);
                uv.push(uvU[c]!, uvV[c]!);
                col.push(1, sky, blk, 1); // r = full AO, g = skylight, b = blocklight
            }
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        const mesh = createMeshFromData(
            this.engine,
            `mc_fall_${this.counter++}`,
            new Float32Array(pos),
            new Float32Array(nrm),
            new Uint32Array(idx),
            new Float32Array(uv),
            undefined,
            undefined,
            new Float32Array(col)
        );
        mesh.material = this.renderer.opaqueMaterial;
        return mesh;
    }
}
