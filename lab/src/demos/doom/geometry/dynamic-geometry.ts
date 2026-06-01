// Manages the subset of level geometry that can change at runtime (doors, lifts,
// moving floors, switch texture swaps). Rebuilt from the live map whenever a
// special marks the world dirty. Materials/textures are cached and reused across
// rebuilds; only mesh GPU buffers are recreated.

import { addToScene, createMeshFromData, removeFromScene, type EngineContext, type SceneContext } from "babylon-lite";

import type { DoomMap } from "../wad/map.js";
import type { DoomTextureCache } from "../render/texture-cache.js";
import { createDoomMaterial } from "../render/doom-material.js";
import { buildLevelBatches } from "./build-level-geometry.js";
import type { SpecialsManager } from "../specials/specials.js";

type Mesh = ReturnType<typeof createMeshFromData>;
type Material = ReturnType<typeof createDoomMaterial>;

export class DynamicGeometry {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly map: DoomMap;
    private readonly textures: DoomTextureCache;
    private readonly colormapTex: Parameters<typeof createDoomMaterial>[2];
    private readonly specials: SpecialsManager;

    private meshes: Mesh[] = [];
    private readonly materials = new Map<string, Material>();
    private counter = 0;

    constructor(
        engine: EngineContext,
        scene: SceneContext,
        map: DoomMap,
        textures: DoomTextureCache,
        colormapTex: Parameters<typeof createDoomMaterial>[2],
        specials: SpecialsManager
    ) {
        this.engine = engine;
        this.scene = scene;
        this.map = map;
        this.textures = textures;
        this.colormapTex = colormapTex;
        this.specials = specials;
        this.rebuild();
    }

    rebuild(): void {
        for (const m of this.meshes) removeFromScene(this.scene, m);
        this.meshes = [];

        const batches = buildLevelBatches(this.map, this.textures, {
            includeLine: (i) => this.specials.dynamicLines.has(i),
            includeSubsector: (i) => this.specials.dynamicSubsectors.has(i),
        });

        for (const [texName, batch] of batches) {
            if (batch.idx.length === 0) continue;
            const src = this.textures.getWall(texName) ?? this.textures.getFlat(texName);
            if (!src) continue;
            const mesh = createMeshFromData(
                this.engine,
                `doomDyn_${this.counter++}_${texName}`,
                new Float32Array(batch.pos),
                new Float32Array(batch.pos.length),
                new Uint32Array(batch.idx),
                new Float32Array(batch.uv),
                undefined,
                undefined,
                new Float32Array(batch.col)
            );
            mesh.material = this.materialFor(texName, src.texture);
            addToScene(this.scene, mesh);
            this.meshes.push(mesh);
        }
    }

    private materialFor(texName: string, texture: Parameters<typeof createDoomMaterial>[1]): Material {
        let mat = this.materials.get(texName);
        if (!mat) {
            mat = createDoomMaterial(`doomDynMat_${texName}`, texture, this.colormapTex);
            this.materials.set(texName, mat);
        }
        return mat;
    }
}
