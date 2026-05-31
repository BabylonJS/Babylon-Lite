// Streams chunk meshes around the player. Each chunk produces up to three meshes
// (opaque / cutout leaves / blended water-glass) built by the culled mesher and
// uploaded via the public createMeshFromData API. Meshing runs on the main thread
// under a per-frame budget so streaming never stalls the render loop. Re-meshing
// on edits rebuilds the touched chunk plus any neighbour whose AO it can affect.

import { addToScene, createMeshFromData, removeFromScene, setSubtreeVisible, type EngineContext, type Mesh, type SceneContext, type ShaderMaterial } from "babylon-lite";

import type { World } from "./world.js";
import type { BlockAtlas } from "./atlas.js";
import { meshChunk, type MeshGeometry } from "./mesher.js";
import { createVoxelMaterial, setVoxelTime, setVoxelCameraPos, setVoxelSun, setVoxelAmbient, setVoxelFogColor, type VoxelMaterialOptions } from "./voxel-material.js";
import { CHUNK_SX, CHUNK_SZ, chunkKey } from "./constants.js";

interface ChunkMeshes {
    meshes: Mesh[];
}

export interface ChunkRendererOptions extends VoxelMaterialOptions {
    /** Horizontal render radius in chunks. */
    radius: number;
    /** Max chunks meshed per frame (streaming budget). */
    budgetPerFrame?: number;
    /** Max light-region floods computed per frame while warming chunks for meshing.
     *  Caps the cold-region burst when a fresh chunk's border light reads cascade a
     *  compute for it and its 8 neighbours. Defaults to 4. */
    computeBudgetPerFrame?: number;
}

export class ChunkRenderer {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly world: World;
    private readonly atlas: BlockAtlas;
    private readonly radius: number;
    private readonly budget: number;
    private readonly computeBudget: number;

    private readonly matOpaque: ShaderMaterial;
    private readonly matCutout: ShaderMaterial;
    private readonly matBlend: ShaderMaterial;

    private readonly active = new Map<string, ChunkMeshes>();
    private readonly pending: { cx: number; cz: number; dist: number }[] = [];
    /** Optional hook fired when a chunk's meshes are first built (or rebuilt from
     *  scratch on activation). Used to seed the water flood for new chunks. */
    onChunkActivated?: (cx: number, cz: number) => void;
    // Meshes removed from rendering but kept alive a few frames before their GPU
    // buffers are freed, so an in-flight submit can never reference a destroyed
    // buffer during heavy streaming churn.
    private readonly graveyard: { meshes: Mesh[]; ttl: number }[] = [];
    private counter = 0;

    constructor(engine: EngineContext, scene: SceneContext, world: World, atlas: BlockAtlas, opts: ChunkRendererOptions) {
        this.engine = engine;
        this.scene = scene;
        this.world = world;
        this.atlas = atlas;
        this.radius = opts.radius;
        this.budget = opts.budgetPerFrame ?? 2;
        this.computeBudget = opts.computeBudgetPerFrame ?? 4;
        this.matOpaque = createVoxelMaterial("voxelOpaque", atlas.texture, "opaque", opts);
        this.matCutout = createVoxelMaterial("voxelCutout", atlas.texture, "cutout", opts);
        this.matBlend = createVoxelMaterial("voxelBlend", atlas.texture, "blend", { ...opts, alpha: 0.72 });
    }

    /** Animate water/glass surfaces and foliage sway. */
    setTime(t: number): void {
        setVoxelTime(this.matBlend, t);
        setVoxelTime(this.matCutout, t);
    }

    /** Update the camera world position (used by water Fresnel reflection). */
    setCameraPos(pos: [number, number, number]): void {
        setVoxelCameraPos(this.matBlend, pos);
    }

    /** Update the directional sun (direction-to-sun + colour) on all variants. */
    setSun(dir: [number, number, number], color: [number, number, number]): void {
        setVoxelSun(this.matOpaque, dir, color);
        setVoxelSun(this.matCutout, dir, color);
        setVoxelSun(this.matBlend, dir, color);
    }

    /** Update the ambient/sky light colour on all variants. */
    setAmbient(color: [number, number, number]): void {
        setVoxelAmbient(this.matOpaque, color);
        setVoxelAmbient(this.matCutout, color);
        setVoxelAmbient(this.matBlend, color);
    }

    /** Update the fog/horizon colour on all variants. */
    setFog(color: [number, number, number]): void {
        setVoxelFogColor(this.matOpaque, color);
        setVoxelFogColor(this.matCutout, color);
        setVoxelFogColor(this.matBlend, color);
    }

    /** Recompute the desired chunk set around a world position and queue work. */
    update(centerWx: number, centerWz: number): void {
        const ccx = Math.floor(centerWx / CHUNK_SX);
        const ccz = Math.floor(centerWz / CHUNK_SZ);
        const keep = this.radius + 1;

        // Unload chunks beyond the keep radius.
        for (const [key, cm] of this.active) {
            const parts = key.split(",");
            const cx = Number(parts[0]);
            const cz = Number(parts[1]);
            if (Math.abs(cx - ccx) > keep || Math.abs(cz - ccz) > keep) {
                this.retire(cm.meshes);
                this.active.delete(key);
                this.world.dropChunk(cx, cz);
            }
        }

        // Queue missing chunks within the render radius, nearest first. `pending` is
        // rebuilt every call, so a chunk that wasn't reached this frame is simply
        // re-queued next frame — no persistent "queued" set is needed (and one would
        // strand chunks the per-frame budget didn't get to).
        this.pending.length = 0;
        for (let dz = -this.radius; dz <= this.radius; dz++) {
            for (let dx = -this.radius; dx <= this.radius; dx++) {
                const cx = ccx + dx;
                const cz = ccz + dz;
                const key = chunkKey(cx, cz);
                if (this.active.has(key)) continue;
                this.pending.push({ cx, cz, dist: dx * dx + dz * dz });
            }
        }
        this.pending.sort((a, b) => a.dist - b.dist);
    }

    /** Process up to `budget` queued chunk meshes. Call once per frame. Pass a larger
     *  `computeBudget` (e.g. Infinity) for the initial warm-up so the spawn area fills
     *  in one pass instead of popping in over several frames. */
    processQueue(computeBudget = this.computeBudget): void {
        this.drainGraveyard();
        // Cap light-region floods this frame: meshing a cold chunk reads light past
        // its border, cascading a compute for it and its 8 neighbours. warmFor()
        // pre-computes that neighbourhood within the budget; if it can't finish, we
        // defer the build a frame rather than stall on a 9-flood burst.
        this.world.light.beginFrame();
        let done = 0;
        while (done < this.budget && this.pending.length > 0) {
            const next = this.pending[0]!;
            if (!this.world.light.warmFor(next.cx, next.cz, computeBudget)) break;
            this.pending.shift();
            const key = chunkKey(next.cx, next.cz);
            if (this.active.has(key)) continue;
            this.buildChunk(next.cx, next.cz);
            this.onChunkActivated?.(next.cx, next.cz);
            done++;
        }
    }

    /** Retire every active chunk mesh (used when reloading the world). The next
     *  update() + processQueue() rebuilds the world around the player. */
    reset(): void {
        for (const cm of this.active.values()) this.retire(cm.meshes);
        this.active.clear();
        this.pending.length = 0;
    }

    /** Rebuild a chunk immediately (used after an edit). */
    remesh(cx: number, cz: number): void {
        const key = chunkKey(cx, cz);
        const existing = this.active.get(key);
        if (existing) {
            this.retire(existing.meshes);
            this.active.delete(key);
        }
        this.buildChunk(cx, cz);
    }

    /** Hide meshes now (so they stop rendering this frame) and free their GPU
     *  buffers a few frames later, once no in-flight submit can reference them. */
    private retire(meshes: Mesh[]): void {
        for (const m of meshes) setSubtreeVisible(m, false);
        this.graveyard.push({ meshes, ttl: 3 });
    }

    private drainGraveyard(): void {
        for (let i = this.graveyard.length - 1; i >= 0; i--) {
            const entry = this.graveyard[i]!;
            if (--entry.ttl > 0) continue;
            for (const m of entry.meshes) removeFromScene(this.scene, m);
            this.graveyard.splice(i, 1);
        }
    }

    /** Rebuild a chunk only if it currently has a live mesh (used after edits). */
    remeshIfActive(cx: number, cz: number): void {
        if (this.active.has(chunkKey(cx, cz))) this.remesh(cx, cz);
    }

    /** Re-mesh the chunk containing world-XZ, plus a neighbour only when the edit
     *  lies on the shared border (so seam face-culling/AO stays correct). An
     *  interior edit touches a single chunk, instead of rebuilding (and re-lighting)
     *  the full 3x3 neighbourhood for every block dug. Neighbour lighting beyond the
     *  seam settles when those chunks next remesh. */
    remeshEdit(wx: number, wz: number): void {
        const cx = Math.floor(wx / CHUNK_SX);
        const cz = Math.floor(wz / CHUNK_SZ);
        const lx = wx - cx * CHUNK_SX;
        const lz = wz - cz * CHUNK_SZ;
        const nx = lx === 0 ? -1 : lx === CHUNK_SX - 1 ? 1 : 0;
        const nz = lz === 0 ? -1 : lz === CHUNK_SZ - 1 ? 1 : 0;
        this.remeshIfActive(cx, cz);
        if (nx) this.remeshIfActive(cx + nx, cz);
        if (nz) this.remeshIfActive(cx, cz + nz);
        if (nx && nz) this.remeshIfActive(cx + nx, cz + nz);
    }

    /** Number of chunks with live meshes. */
    get activeCount(): number {
        return this.active.size;
    }

    /** The opaque voxel material (kept in sync with the day-night cycle), reused by
     *  falling-block entities so they light consistently with the terrain. */
    get opaqueMaterial(): ShaderMaterial {
        return this.matOpaque;
    }

    private buildChunk(cx: number, cz: number): void {
        const data = meshChunk(this.world, cx, cz, this.atlas);
        const meshes: Mesh[] = [];
        const add = (geo: MeshGeometry | null, mat: ShaderMaterial, tag: string, order: number): void => {
            if (!geo) return;
            const normals = geo.normals;
            const mesh = createMeshFromData(this.engine, `mc_${tag}_${this.counter++}`, geo.positions, normals, geo.indices, geo.uvs, undefined, undefined, geo.colors);
            mesh.material = mat;
            mesh.renderOrder = order;
            addToScene(this.scene, mesh);
            meshes.push(mesh);
        };
        add(data.opaque, this.matOpaque, "op", 0);
        add(data.cutout, this.matCutout, "ct", 1);
        add(data.blend, this.matBlend, "bl", 1000);
        this.active.set(chunkKey(cx, cz), { meshes });
    }

    dispose(): void {
        this.drainGraveyard();
        for (const entry of this.graveyard) {
            for (const m of entry.meshes) removeFromScene(this.scene, m);
        }
        this.graveyard.length = 0;
        for (const cm of this.active.values()) {
            for (const m of cm.meshes) removeFromScene(this.scene, m);
        }
        this.active.clear();
    }
}
