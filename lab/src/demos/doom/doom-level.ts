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
import { NF_SUBSECTOR } from "./wad/map.js";
import { buildCollisionLines, tryMove, VIEW_HEIGHT } from "./physics/collision.js";

const MOVE_SPEED = 320; // map units per second
const TURN_SPEED = 2.4; // radians per second

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
    const batches = buildLevelBatches(map, textures);

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

    installCamera(scene, map);

    return { map, dispose: () => {} };
}

function installCamera(scene: SceneContext, map: DoomMap): void {
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
    const collLines = buildCollisionLines(map);
    const keys = new Set<string>();
    const onDown = (e: KeyboardEvent): void => {
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
        const currentFloor = floorHeightAt(map, eye.x, eye.z);
        const moved = tryMove(collLines, eye.x, eye.z, mx * speed, mz * speed, currentFloor);
        eye.x = moved.x;
        eye.z = moved.y;
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
    if (map.nodes.length === 0) return 0;
    let ref = map.nodes.length - 1;
    while (!(ref & NF_SUBSECTOR)) {
        const node = map.nodes[ref];
        if (!node) return 0;
        const s = node.dx * (y - node.y) - node.dy * (x - node.x);
        ref = s <= 0 ? node.rightChild : node.leftChild;
    }
    const ss = map.subsectors[ref & ~NF_SUBSECTOR];
    if (!ss) return 0;
    const seg = map.segs[ss.firstSeg];
    if (!seg) return 0;
    const ld = map.linedefs[seg.linedef];
    if (!ld) return 0;
    const sideRef = seg.side === 0 ? ld.front : ld.back;
    if (sideRef < 0) return 0;
    const side = map.sidedefs[sideRef];
    return side ? (map.sectors[side.sector]?.floorHeight ?? 0) : 0;
}
