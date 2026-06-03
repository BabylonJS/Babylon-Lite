// Real pickup-item models for the E1M1 demo (replaces placeholder boxes).
//
// Quake renders pickups with two different model formats:
//   • weapons / armor / artifacts are alias (.mdl) models in progs/  — rendered
//     with the same path as monsters (frame 0, fullbright skin).
//   • ammo / health pickups are tiny brush (.bsp) models in maps/    — their
//     model[0] geometry is rebuilt fullbright from the brush's own miptextures.
//
// Each instance is dropped to the floor and returned as a SpawnedItem so the
// demo can spin it (Quake-3 style) and grant its pickup when the player touches
// it. Geometry is loaded once per distinct model and the vertex arrays are
// shared across instances (only per-mesh transforms differ).

import { addToScene, createMeshFromData, createTexture2DFromPixels, type EngineContext, type Mesh, type SceneContext, type Texture2D } from "babylon-lite";

import { parseBsp, type BspData, type BspModel } from "../bsp/parse-bsp.js";
import { parseMdl, expandFrame } from "./mdl.js";
import { createQuakeMaterial } from "./quake-material.js";
import { QuakeTextureCache } from "./texture-cache.js";
import { quakeToEngine } from "../geometry/build-geometry.js";
import type { QuakePhysics } from "../physics/collision.js";
import type { Palette } from "../palette.js";
import type { WorldEnt } from "../entities/mover-system.js";
import { demoAssetUrl } from "../../demo-asset-url.js";

type V3 = [number, number, number];

const ASSET_BASE = demoAssetUrl("./librequake", import.meta.url);

/** Brush-model faces with these textures are clip/skip surfaces — never drawn. */
const SKIP_TEXTURES = new Set(["skip", "clip", "trigger", "hint", "hintskip", "waterskip"]);

type ItemDesc = { kind: "mdl"; file: string; skin: number } | { kind: "brush"; file: string };

const mdl = (name: string, skin = 0): ItemDesc => ({ kind: "mdl", file: `progs/${name}.mdl`, skin });
const brush = (name: string): ItemDesc => ({ kind: "brush", file: `maps/${name}.bsp` });
const descKey = (d: ItemDesc): string => (d.kind === "mdl" ? `mdl:${d.file}:${d.skin}` : `bsp:${d.file}`);

/** Map an item entity (classname + spawnflags) to the model Quake would render. */
function resolveItemModel(cls: string, flags: number): ItemDesc | null {
    switch (cls) {
        case "weapon_supershotgun":
            return mdl("g_shot");
        case "weapon_nailgun":
            return mdl("g_nail");
        case "weapon_supernailgun":
            return mdl("g_nail2");
        case "weapon_grenadelauncher":
            return mdl("g_rock");
        case "weapon_rocketlauncher":
            return mdl("g_rock2");
        case "weapon_lightning":
            return mdl("g_light");
        case "item_armor1":
            return mdl("armor", 0); // green
        case "item_armor2":
            return mdl("armor", 1); // yellow
        case "item_armorInv":
            return mdl("armor", 2); // red
        case "item_artifact_super_damage":
            return mdl("quaddama");
        case "item_artifact_envirosuit":
            return mdl("suit");
        case "item_artifact_invulnerability":
            return mdl("invulner");
        case "item_artifact_invisibility":
            return mdl("invisibl");
        case "item_health":
            return brush(flags & 2 ? "b_bh100" : flags & 1 ? "b_bh10" : "b_bh25");
        case "item_shells":
            return brush(flags & 1 ? "b_shell1" : "b_shell0");
        case "item_spikes":
            return brush(flags & 1 ? "b_nail1" : "b_nail0");
        case "item_rockets":
            return brush(flags & 1 ? "b_rock1" : "b_rock0");
        case "item_cells":
            return brush(flags & 1 ? "b_batt1" : "b_batt0");
        default:
            return null;
    }
}

/** One drawable sub-mesh of a model: local engine-space geometry + its texture. */
interface ItemPart {
    posLocal: Float32Array; // engine space, model-local (origin at 0)
    uv: Float32Array;
    uv2: Float32Array; // lightmap UV (fullbright white)
    indices: Uint32Array;
    tex: Texture2D;
}

export interface ItemModelDeps {
    engine: EngineContext;
    scene: SceneContext;
    palette: Palette;
    lightTex: Texture2D;
    whiteUV: [number, number];
    physics: QuakePhysics;
}

/** Build engine-space, model-local geometry for one brush model, fullbright. */
function buildBrushParts(bsp: BspData, model: BspModel, whiteUV: [number, number], textures: QuakeTextureCache): ItemPart[] {
    interface Batch {
        pos: number[];
        uv: number[];
        uv2: number[];
        idx: number[];
    }
    const [whiteU, whiteV] = whiteUV;
    const batches = new Map<number, Batch>();
    const getBatch = (miptex: number): Batch => {
        let b = batches.get(miptex);
        if (!b) {
            b = { pos: [], uv: [], uv2: [], idx: [] };
            batches.set(miptex, b);
        }
        return b;
    };

    for (let fi = model.firstFace; fi < model.firstFace + model.numFaces; fi++) {
        const face = bsp.faces[fi];
        if (!face) continue;
        const ti = bsp.texInfos[face.texInfo];
        if (!ti) continue;
        const mt = bsp.mipTextures[ti.miptex];
        if (mt && SKIP_TEXTURES.has(mt.name.toLowerCase())) continue;
        const texW = mt && mt.width > 0 ? mt.width : 64;
        const texH = mt && mt.height > 0 ? mt.height : 64;

        const n = face.numEdges;
        if (n < 3) continue;
        const batch = getBatch(ti.miptex);
        const base = batch.pos.length / 3;
        const v = ti.vecs;
        for (let k = 0; k < n; k++) {
            const se = bsp.surfEdges[face.firstEdge + k]!;
            const vIndex = se >= 0 ? bsp.edges[se * 2]! : bsp.edges[-se * 2 + 1]!;
            const px = bsp.vertices[vIndex * 3]!;
            const py = bsp.vertices[vIndex * 3 + 1]!;
            const pz = bsp.vertices[vIndex * 3 + 2]!;
            const [ex, ey, ez] = quakeToEngine(px, py, pz);
            batch.pos.push(ex, ey, ez);
            batch.uv.push((px * v[0]! + py * v[1]! + pz * v[2]! + v[3]!) / texW, (px * v[4]! + py * v[5]! + pz * v[6]! + v[7]!) / texH);
            batch.uv2.push(whiteU, whiteV);
        }
        for (let k = 1; k < n - 1; k++) batch.idx.push(base, base + k, base + k + 1);
    }

    const parts: ItemPart[] = [];
    for (const [miptex, b] of batches) {
        if (b.idx.length === 0) continue;
        parts.push({
            posLocal: new Float32Array(b.pos),
            uv: new Float32Array(b.uv),
            uv2: new Float32Array(b.uv2),
            indices: new Uint32Array(b.idx),
            tex: textures.get(miptex).texture,
        });
    }
    return parts;
}

/** Build engine-space, model-local geometry for one alias (.mdl) item, fullbright. */
function buildMdlParts(deps: ItemModelDeps, buffer: ArrayBuffer, skin: number, whiteUV: [number, number]): ItemPart[] {
    const model = parseMdl(buffer, deps.palette, skin);
    const corners = model.indices.length;
    const posLocal = new Float32Array(corners * 3);
    expandFrame(model, 0, posLocal);
    const uv2 = new Float32Array(corners * 2);
    for (let i = 0; i < corners; i++) {
        uv2[i * 2] = whiteUV[0];
        uv2[i * 2 + 1] = whiteUV[1];
    }
    const tex = createTexture2DFromPixels(deps.engine, model.skinRgba, model.skinWidth, model.skinHeight, {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        minFilter: "linear",
        magFilter: "linear",
    });
    return [{ posLocal, uv: model.uvs, uv2, indices: model.indices, tex }];
}

/** Drop an item to the floor (Quake droptofloor) so it rests on the ground.
 *  Quake limits the drop to 256 units; if no floor is found within that range
 *  the point trace has slipped through a gap, so the authored origin is kept. */
function dropToFloor(physics: QuakePhysics, o: V3): V3 {
    const tr = physics.castMove([o[0], o[1], o[2]], [o[0], o[1], o[2] - 256]);
    return tr.fraction < 1 ? [o[0], o[1], tr.endpos[2]] : [o[0], o[1], o[2]];
}

/**
 * A spawned pickup instance: its part meshes (which spin together around the
 * model's vertical centre) and the dropped Quake-space origin used for pickup
 * proximity tests. `picked` is set once the player collects it.
 */
export interface SpawnedItem {
    cls: string;
    flags: number;
    qpos: V3;
    meshes: Mesh[];
    picked: boolean;
}

/** A loaded model: parts whose vertices are horizontally centred on the spin pivot. */
interface ItemTemplate {
    parts: ItemPart[];
    cx: number;
    cz: number;
}

/** Centre each part's vertices on the model's horizontal mid-point so a Y-axis
 *  rotation spins the whole item in place rather than orbiting a corner. */
function centerTemplate(parts: ItemPart[]): ItemTemplate {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const part of parts) {
        const p = part.posLocal;
        for (let i = 0; i < p.length; i += 3) {
            if (p[i]! < minX) minX = p[i]!;
            if (p[i]! > maxX) maxX = p[i]!;
            if (p[i + 2]! < minZ) minZ = p[i + 2]!;
            if (p[i + 2]! > maxZ) maxZ = p[i + 2]!;
        }
    }
    const cx = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
    const cz = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0;
    for (const part of parts) {
        const p = part.posLocal;
        for (let i = 0; i < p.length; i += 3) {
            p[i] = p[i]! - cx;
            p[i + 2] = p[i + 2]! - cz;
        }
    }
    return { parts, cx, cz };
}

/**
 * Spawn every pickup item in the map as its real Quake model. Each instance is
 * dropped to the floor and returned so the demo can spin it and handle pickup.
 * Must be awaited before the scene is registered.
 */
export async function spawnItemModels(deps: ItemModelDeps, ents: WorldEnt[]): Promise<SpawnedItem[]> {
    const items = ents.filter((e) => e.isItem);

    // Resolve each item to a model descriptor; collect the unique set to load.
    const descByEnt = new Map<WorldEnt, ItemDesc>();
    const unique = new Map<string, ItemDesc>();
    for (const ent of items) {
        const desc = resolveItemModel(ent.cls, Number(ent.kv.spawnflags) || 0);
        if (!desc) continue;
        descByEnt.set(ent, desc);
        unique.set(descKey(desc), desc);
    }

    // Load + build each distinct model's parts once (geometry is shared across instances).
    const templates = new Map<string, ItemTemplate>();
    await Promise.all(
        [...unique.values()].map(async (desc) => {
            const res = await fetch(`${ASSET_BASE}/${desc.file}`);
            if (!res.ok) throw new Error(`Failed to fetch ${desc.file}: ${res.status}`);
            const buffer = await res.arrayBuffer();
            if (desc.kind === "mdl") {
                templates.set(descKey(desc), centerTemplate(buildMdlParts(deps, buffer, desc.skin, deps.whiteUV)));
            } else {
                const bsp = parseBsp(buffer);
                const textures = new QuakeTextureCache(deps.engine, bsp.mipTextures, deps.palette);
                templates.set(descKey(desc), centerTemplate(buildBrushParts(bsp, bsp.models[0]!, deps.whiteUV, textures)));
            }
        })
    );

    // Instantiate each item: one mesh per texture part, positioned on the spin pivot.
    const spawned: SpawnedItem[] = [];
    let id = 0;
    for (const ent of items) {
        const desc = descByEnt.get(ent);
        if (!desc) continue;
        const tmpl = templates.get(descKey(desc));
        if (!tmpl) continue;
        const qpos = dropToFloor(deps.physics, ent.origin);
        const [ox, oy, oz] = quakeToEngine(qpos[0], qpos[1], qpos[2]);
        const px = ox + tmpl.cx;
        const pz = oz + tmpl.cz;
        const meshes: Mesh[] = [];
        for (const part of tmpl.parts) {
            const mesh = createMeshFromData(deps.engine, `quake_item_${id}`, part.posLocal, new Float32Array(part.posLocal.length), part.indices, part.uv, part.uv2);
            mesh.material = createQuakeMaterial(`quakeItemMat_${id}`, part.tex, deps.lightTex);
            mesh.position.set(px, oy, pz);
            addToScene(deps.scene, mesh);
            meshes.push(mesh);
            id++;
        }
        spawned.push({ cls: ent.cls, flags: Number(ent.kv.spawnflags) || 0, qpos, meshes, picked: false });
    }
    return spawned;
}
