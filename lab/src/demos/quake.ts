/**
 * LibreQuake demo — Milestone 1: faithful E1M1 map rendering.
 *
 * Fetches the LibreQuake first-level BSP (BSD-3-Clause free game data, lazy-loaded
 * as a static asset — never bundled into JS), parses it clean-room from the
 * publicly documented Quake BSP v29 format, rebuilds the level geometry with
 * embedded textures and grayscale BSP lightmaps, and renders it with a free-fly
 * first-person camera spawned at info_player_start.
 *
 * Controls: WASD / arrows to move, mouse-drag to look, Space / Shift to fly up/down.
 *
 * Asset license: LibreQuake (https://github.com/lavenderdotpet/LibreQuake), BSD-3-Clause.
 * Run `pnpm fetch:librequake` to download the data into lab/public/librequake/.
 */

import {
    addToScene,
    attachFreeControl,
    createEngine,
    createFreeCamera,
    createMeshFromData,
    createSceneContext,
    createTexture2DFromPixels,
    registerScene,
    startEngine,
} from "babylon-lite";

import { parseBsp } from "./quake/bsp/parse-bsp.js";
import { parsePalette } from "./quake/palette.js";
import { parseEntities, parseVec3 } from "./quake/entities/parse-entities.js";
import { buildLevelGeometry, quakeToEngine } from "./quake/geometry/build-geometry.js";
import { QuakeTextureCache } from "./quake/render/texture-cache.js";
import { createQuakeMaterial } from "./quake/render/quake-material.js";

const BSP_URL = "/librequake/lq_e1m1.bsp";
const PALETTE_URL = "/librequake/palette.lmp";
const PLAYER_EYE_OFFSET = 22; // Quake view height above the entity origin.

async function fetchBytes(url: string, hint: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}. ${hint}`);
    return res.arrayBuffer();
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.05, b: 0.07, a: 1 };

    const hint = "Run `pnpm fetch:librequake`.";
    const [bspBytes, palBytes] = await Promise.all([fetchBytes(BSP_URL, hint), fetchBytes(PALETTE_URL, hint)]);

    const bsp = parseBsp(bspBytes);
    const palette = parsePalette(palBytes);
    const entities = parseEntities(bsp.entities);

    // Decode textures and rebuild geometry batched per texture.
    const textures = new QuakeTextureCache(engine, bsp.mipTextures, palette);
    const { batches, atlas } = buildLevelGeometry(bsp);

    const lightTex = createTexture2DFromPixels(engine, atlas.pixels, atlas.width, atlas.height, {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        minFilter: "linear",
        magFilter: "linear",
    });

    let i = 0;
    let drawn = 0;
    for (const [miptex, batch] of batches) {
        if (batch.idx.length === 0) continue;
        const diffuse = textures.get(miptex);
        const positions = new Float32Array(batch.pos);
        const normals = new Float32Array(batch.pos.length);
        const indices = new Uint32Array(batch.idx);
        const uvs = new Float32Array(batch.uv);
        const uvs2 = new Float32Array(batch.uv2);
        const mesh = createMeshFromData(engine, `quake_${i}_${diffuse.width}`, positions, normals, indices, uvs, uvs2);
        mesh.material = createQuakeMaterial(`quakeMat_${i}`, diffuse.texture, lightTex);
        addToScene(scene, mesh);
        drawn++;
        i++;
    }

    // Spawn camera at info_player_start.
    const start = entities.find((e) => e.classname === "info_player_start") ?? entities.find((e) => e.classname?.startsWith("info_player"));
    const origin = parseVec3(start?.origin);
    const [ex, ey, ez] = quakeToEngine(origin[0], origin[1], origin[2]);
    const angleDeg = start?.angle ? Number(start.angle) : 0;
    const yaw = (angleDeg * Math.PI) / 180;
    const eye = { x: ex, y: ey + PLAYER_EYE_OFFSET, z: ez };
    const cam = createFreeCamera(eye, { x: eye.x + Math.cos(yaw), y: eye.y, z: eye.z + Math.sin(yaw) });
    cam.speed = 350;
    cam.nearPlane = 1;
    cam.farPlane = 20000;
    scene.camera = cam;
    attachFreeControl(cam, canvas, scene);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(drawn);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) canvas.dataset.error = String(err);
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;color:#0f0;background:#000;font:14px monospace;white-space:pre-wrap;z-index:9999;";
    pre.textContent = `${String(err)}\n\n${err && err.stack ? err.stack : ""}`;
    document.body.appendChild(pre);
});
