// Orchestrates a playable DOOM level: parses a WAD, decodes the palette/colormap,
// builds per-texture geometry batches, uploads them as meshes, and installs a
// free-fly camera at the player-1 start with keyboard controls.

import { addToScene, createFreeCamera, createMeshFromData, createTexture2DFromPixels, onBeforeRender, type EngineContext, type SceneContext } from "babylon-lite";

import { parseWad } from "./wad/wad-file.js";
import { parseMap } from "./wad/map.js";
import type { DoomMap } from "./wad/map.js";
import { parsePlaypal, parseColormap, buildColormapLut } from "./wad/palette.js";
import { DoomTextureCache } from "./render/texture-cache.js";
import { createDoomMaterial } from "./render/doom-material.js";
import { buildLevelBatches } from "./geometry/build-level-geometry.js";
import { DynamicGeometry } from "./geometry/dynamic-geometry.js";
import { SpecialsManager } from "./specials/specials.js";
import { NF_SUBSECTOR } from "./wad/map.js";
import { buildCollisionLines, tryMove, VIEW_HEIGHT } from "./physics/collision.js";

const MOVE_SPEED = 320; // map units per second
const TURN_SPEED = 2.4; // radians per second
const TIC_SECONDS = 1 / 35; // DOOM simulation tic rate

export interface DoomLevel {
    map: DoomMap;
    dispose(): void;
}

export function buildDoomLevel(engine: EngineContext, scene: SceneContext, wadBytes: ArrayBuffer, mapName = "E1M1"): DoomLevel {
    const wad = parseWad(wadBytes);
    const map = parseMap(wad, mapName);

    const playpal = parsePlaypal(wad);
    const colormap = parseColormap(wad);
    const lut = buildColormapLut(playpal, colormap);
    const colormapTex = createTexture2DFromPixels(engine, lut, 256, 34, {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });

    const textures = new DoomTextureCache(engine, wad);

    const playerSectorRef = { value: -1 };
    const specials = new SpecialsManager(map, {
        onExit: () => console.log("[doom] level exit triggered"),
        playerSector: () => playerSectorRef.value,
    });

    // Static geometry excludes anything the specials can mutate at runtime.
    const batches = buildLevelBatches(map, textures, {
        includeLine: (i) => !specials.dynamicLines.has(i),
        includeSubsector: (i) => !specials.dynamicSubsectors.has(i),
    });

    let i = 0;
    for (const [texName, batch] of batches) {
        if (batch.idx.length === 0) continue;
        const src = textures.getWall(texName) ?? textures.getFlat(texName);
        if (!src) continue;
        const positions = new Float32Array(batch.pos);
        const normals = new Float32Array(batch.pos.length); // unused by material
        const indices = new Uint32Array(batch.idx);
        const uvs = new Float32Array(batch.uv);
        const colors = new Float32Array(batch.col);
        const mesh = createMeshFromData(engine, `doom_${i}_${texName}`, positions, normals, indices, uvs, undefined, undefined, colors);
        mesh.material = createDoomMaterial(`doomMat_${i}_${texName}`, src.texture, colormapTex);
        addToScene(scene, mesh);
        i++;
    }

    const dynamicGeo = new DynamicGeometry(engine, scene, map, textures, colormapTex, specials);

    installCamera(scene, map, specials, dynamicGeo, playerSectorRef);

    return { map, dispose: () => {} };
}

function installCamera(scene: SceneContext, map: DoomMap, specials: SpecialsManager, dynamicGeo: DynamicGeometry, playerSectorRef: { value: number }): void {
    const start = map.things.find((t) => t.type === 1) ?? map.things[0];
    const sx = start ? start.x : 0;
    const sz = start ? start.y : 0;
    const floorH = floorHeightAt(map, sx, sz);
    const yaw0 = start ? (start.angle * Math.PI) / 180 : 0;

    const eye = { x: sx, y: floorH + VIEW_HEIGHT, z: sz };
    const cam = createFreeCamera(eye, { x: sx + Math.cos(yaw0), y: floorH + VIEW_HEIGHT, z: sz + Math.sin(yaw0) });
    cam.nearPlane = 1;
    cam.farPlane = 12000;
    scene.camera = cam;

    let yaw = yaw0;
    let ticAccum = 0;
    let usePressed = false;
    const collLines = buildCollisionLines(map);
    const keys = new Set<string>();
    const onDown = (e: KeyboardEvent): void => {
        if (e.code === "Space" && !keys.has("Space")) usePressed = true;
        keys.add(e.code);
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent): void => void keys.delete(e.code);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    onBeforeRender(scene, (deltaMs) => {
        const dt = deltaMs / 1000;
        const strafeMod = keys.has("AltLeft") || keys.has("AltRight");
        if (!strafeMod) {
            if (keys.has("ArrowLeft")) yaw += TURN_SPEED * dt;
            if (keys.has("ArrowRight")) yaw -= TURN_SPEED * dt;
        }

        const fx = Math.cos(yaw);
        const fz = Math.sin(yaw);
        const speed = (keys.has("ShiftLeft") ? 2 : 1) * MOVE_SPEED * dt;
        let mx = 0;
        let mz = 0;
        if (keys.has("ArrowUp")) {
            mx += fx;
            mz += fz;
        }
        if (keys.has("ArrowDown")) {
            mx -= fx;
            mz -= fz;
        }
        const strafeLeft = keys.has("Comma") || (strafeMod && keys.has("ArrowLeft"));
        const strafeRight = keys.has("Period") || (strafeMod && keys.has("ArrowRight"));
        if (strafeLeft) {
            mx -= fz;
            mz += fx;
        }
        if (strafeRight) {
            mx += fz;
            mz -= fx;
        }
        const fromX = eye.x;
        const fromZ = eye.z;
        const currentFloor = floorHeightAt(map, eye.x, eye.z);
        const moved = tryMove(collLines, eye.x, eye.z, mx * speed, mz * speed, currentFloor, map.sectors);
        eye.x = moved.x;
        eye.z = moved.y;
        playerSectorRef.value = sectorIndexAt(map, eye.x, eye.z);

        // World interactivity: USE (Space), walk-over triggers, and timed movers.
        if (usePressed) {
            specials.tryUse(eye.x, eye.z, yaw);
            usePressed = false;
        }
        if (fromX !== eye.x || fromZ !== eye.z) {
            specials.crossLines(fromX, fromZ, eye.x, eye.z);
        }
        ticAccum += dt;
        while (ticAccum >= TIC_SECONDS) {
            specials.tic();
            ticAccum -= TIC_SECONDS;
        }
        if (specials.consumeDirty()) dynamicGeo.rebuild();

        // Recompute eye height after movers have run so the view tracks lifts/floors.
        eye.y = floorHeightAt(map, eye.x, eye.z) + VIEW_HEIGHT;

        cam.position.x = eye.x;
        cam.position.y = eye.y;
        cam.position.z = eye.z;
        cam.target.x = eye.x + fx;
        cam.target.y = eye.y;
        cam.target.z = eye.z + fz;
    });
}

/** Walks the BSP to the subsector containing (doomX, doomY), returns its sector floor height. */
function floorHeightAt(map: DoomMap, x: number, y: number): number {
    const sec = sectorIndexAt(map, x, y);
    return sec < 0 ? 0 : (map.sectors[sec]?.floorHeight ?? 0);
}

/** Walks the BSP to the subsector containing (doomX, doomY), returns its sector index (or -1). */
function sectorIndexAt(map: DoomMap, x: number, y: number): number {
    if (map.nodes.length === 0) return -1;
    let ref = map.nodes.length - 1;
    while (!(ref & NF_SUBSECTOR)) {
        const node = map.nodes[ref];
        if (!node) return -1;
        const s = node.dx * (y - node.y) - node.dy * (x - node.x);
        ref = s <= 0 ? node.rightChild : node.leftChild;
    }
    const ss = map.subsectors[ref & ~NF_SUBSECTOR];
    if (!ss) return -1;
    const seg = map.segs[ss.firstSeg];
    if (!seg) return -1;
    const ld = map.linedefs[seg.linedef];
    if (!ld) return -1;
    const sideRef = seg.side === 0 ? ld.front : ld.back;
    if (sideRef < 0) return -1;
    const side = map.sidedefs[sideRef];
    return side ? side.sector : -1;
}
