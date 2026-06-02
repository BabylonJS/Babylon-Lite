/**
 * Voxel Sandbox (Minecraft-style) demo — creative mode.
 *
 * A clean-room, pure-Babylon-Lite voxel sandbox. Terrain is generated procedurally
 * and deterministically, meshed with culled face meshing + ambient occlusion, and
 * textured from the freely-licensed Kenney Voxel Pack (CC0), fetched as a static
 * asset (never bundled). Fly around, break (left click) and place (right click)
 * blocks from a creative hotbar.
 *
 * No engine internals are used: everything goes through the public Babylon Lite API,
 * and any missing capability is added as a properly-exported, tree-shakable engine
 * function.
 */

import { addToScene, createEngine, createSceneContext, onBeforeRender, registerScene, startEngine } from "babylon-lite";

import { allReferencedTiles, blockDef, HOTBAR, Block } from "./minecraft/blocks.js";
import { buildBlockAtlas } from "./minecraft/atlas.js";
import { World } from "./minecraft/world.js";
import { CHUNK_SX, CHUNK_SZ } from "./minecraft/constants.js";
import { ChunkRenderer } from "./minecraft/chunk-renderer.js";
import { createSky } from "./minecraft/sky.js";
import { createHighlight } from "./minecraft/highlight.js";
import { Hud, type HotbarSlotInfo } from "./minecraft/hud.js";
import { PlayerController } from "./minecraft/controls.js";
import { Lighting } from "./minecraft/lighting.js";
import { ParticleSystem } from "./minecraft/particles.js";
import { createClouds } from "./minecraft/clouds.js";
import { FallingBlocks } from "./minecraft/falling-blocks.js";
import { WaterSim } from "./minecraft/water-sim.js";
import { Mobs } from "./minecraft/mobs.js";
import { saveToFile, loadFromFile, type SaveData } from "./minecraft/save-load.js";

const PACK_URL = "/minecraft/voxelpack";
const SEED = 1337;
const RENDER_RADIUS = 6;

const FOG_COLOR: [number, number, number] = [0.7, 0.82, 0.92];
const FOG_START = (RENDER_RADIUS - 1) * 16 * 0.6;
const FOG_END = RENDER_RADIUS * 16 * 0.95;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: FOG_COLOR[0], g: FOG_COLOR[1], b: FOG_COLOR[2], a: 1 };

    const atlas = await buildBlockAtlas(engine, PACK_URL, allReferencedTiles());
    const world = new World(SEED);

    const renderer = new ChunkRenderer(engine, scene, world, atlas, {
        radius: RENDER_RADIUS,
        budgetPerFrame: 3,
        fogColor: FOG_COLOR,
        fogStart: FOG_START,
        fogEnd: FOG_END,
    });

    const sky = createSky(engine, { horizonColor: FOG_COLOR });
    addToScene(scene, sky.mesh);

    const timeParam = new URLSearchParams(location.search).get("time");
    const startTimeOfDay = timeParam !== null ? Number(timeParam) : undefined;
    const lighting = new Lighting({ dayLengthSec: 150, startTimeOfDay });
    lighting.applyTo(sky, renderer, scene);

    const highlight = createHighlight(engine);
    addToScene(scene, highlight.mesh);

    const hotbar: HotbarSlotInfo[] = HOTBAR.map((id, i) => {
        const d = blockDef(id);
        const tile = d ? d.faces.side : "stone";
        return { name: d ? d.name : "Block", iconUrl: `${PACK_URL}/${tile}.png`, key: String(i + 1) };
    });
    const hud = new Hud(document.body, hotbar);

    // Underwater tint overlay: a full-screen blue wash that fades in when the
    // camera is submerged in water, sold as a DOM layer so it costs nothing on the
    // GPU and never affects the scene render.
    const underwater = document.createElement("div");
    underwater.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:50;opacity:0;transition:opacity 0.25s ease;" +
        "background:radial-gradient(ellipse at center,rgba(30,90,150,0.35) 0%,rgba(12,48,96,0.6) 100%);" +
        "box-shadow:inset 0 0 220px 60px rgba(4,26,60,0.85);";
    document.body.appendChild(underwater);

    const particles = new ParticleSystem(engine, scene);
    const falling = new FallingBlocks(engine, scene, world, renderer, atlas);
    const water = new WaterSim(world, renderer);
    // Flood connected sub-sea-level air (caves opening into the seafloor) from the
    // ocean as each chunk activates, so there are never dry pockets under water.
    renderer.onChunkActivated = (cx, cz) => water.settleChunk(cx, cz);
    const player = new PlayerController(scene, world, renderer, highlight, hud, canvas, particles, falling, water);

    const mobs = new Mobs(engine, scene, world, { fogStart: FOG_START, fogEnd: FOG_END, fogColor: FOG_COLOR });

    const clouds = createClouds(engine, scene);

    // Pre-flood a render-region around (px,pz) and warm up its chunk meshes so the
    // world is solid + correctly flooded on the very next frame (no first-frame dry
    // pockets, no warm-up remesh storm). Shared by initial boot and world reload.
    const warmAround = (px: number, pz: number): void => {
        const ccx = Math.floor(px / CHUNK_SX);
        const ccz = Math.floor(pz / CHUNK_SZ);
        const region: [number, number][] = [];
        for (let dz = -RENDER_RADIUS; dz <= RENDER_RADIUS; dz++) {
            for (let dx = -RENDER_RADIUS; dx <= RENDER_RADIUS; dx++) region.push([ccx + dx, ccz + dz]);
        }
        water.prefill(region);
        renderer.update(px, pz);
        // Unlimited light-compute budget here so the spawn region fills in one pass
        // (no pop-in at load); steady-state frames use the capped per-frame budget.
        for (let i = 0; i < (2 * RENDER_RADIUS + 1) * (2 * RENDER_RADIUS + 1) + 4; i++) renderer.processQueue(Infinity);
    };

    warmAround(player.camera.position.x, player.camera.position.z);

    // ── Save / load (Ctrl+S / Ctrl+O) ────────────────────────────────────────
    // The terrain is deterministic from the seed, so a save is just seed + player
    // transform + time-of-day + the sparse player block edits.
    const captureState = (): SaveData => ({
        v: 1,
        seed: world.seed,
        time: lighting.time,
        player: player.getState(),
        edits: world.exportEdits(),
    });
    const applyState = (data: SaveData): void => {
        world.reset(data.seed, data.edits);
        renderer.reset();
        water.reset();
        falling.reset();
        mobs.reset();
        lighting.time = data.time;
        player.setState(data.player);
        warmAround(data.player.x, data.player.z);
    };
    let busy = false;
    window.addEventListener("keydown", (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const k = e.key.toLowerCase();
        if (k !== "s" && k !== "o") return;
        e.preventDefault();
        if (busy) return;
        busy = true;
        void (async () => {
            try {
                if (k === "s") {
                    const ok = await saveToFile(captureState());
                    if (ok) hud.toast("World saved");
                } else {
                    const data = await loadFromFile();
                    if (data) {
                        applyState(data);
                        hud.toast("World loaded");
                    } else {
                        hud.toast("Load cancelled");
                    }
                }
            } catch (err) {
                console.error(err);
                hud.toast("Save/load failed");
            } finally {
                busy = false;
            }
        })();
    });

    // Frame loop.
    let time = 0;
    let fps = 60;
    onBeforeRender(scene, (deltaMs: number) => {
        const dt = Math.min(deltaMs / 1000, 0.1);
        time += dt;
        fps = fps * 0.9 + (1 / Math.max(dt, 1e-4)) * 0.1;

        player.update(dt);
        falling.update(dt);
        water.update(dt);
        renderer.processQueue();
        renderer.setTime(time);
        renderer.setCameraPos([player.camera.position.x, player.camera.position.y, player.camera.position.z]);
        highlight.setTime(time);
        particles.update(dt);

        // Underwater tint when the camera (eye) is inside a water voxel.
        const submerged =
            world.getBlock(
                Math.floor(player.camera.position.x),
                Math.floor(player.camera.position.y),
                Math.floor(player.camera.position.z)
            ) === Block.WATER;
        underwater.style.opacity = submerged ? "1" : "0";

        // Advance the day-night cycle and push lighting to sky + materials.
        lighting.tick(dt);
        lighting.applyTo(sky, renderer, scene);

        // Drift the clouds and tint them with the current sky/sun colour. The
        // brightness offset is scaled by a day factor so clouds are bright white by
        // day but dim to a faint blue-grey at night instead of glowing.
        const ls = lighting.snapshot();
        mobs.setLighting(ls.sunDir, ls.sunColor, ls.ambientColor, ls.fogColor);
        mobs.update(dt, [player.camera.position.x, player.camera.position.y, player.camera.position.z]);
        const dayF = Math.max(0, Math.min(1, (ls.sunDir[1] + 0.05) / 0.3));
        const off = 0.03 + 0.32 * dayF;
        clouds.setTint([
            Math.min(1, ls.ambientColor[0] * 0.6 + ls.sunColor[0] * 0.7 + off),
            Math.min(1, ls.ambientColor[1] * 0.6 + ls.sunColor[1] * 0.7 + off),
            Math.min(1, ls.ambientColor[2] * 0.6 + ls.sunColor[2] * 0.7 + off + 0.02),
        ]);
        clouds.update(player.camera.position.x, player.camera.position.z, time);

        // Keep the sky dome centered on the camera.
        sky.mesh.position.x = player.camera.position.x;
        sky.mesh.position.y = player.camera.position.y;
        sky.mesh.position.z = player.camera.position.z;

        hud.setFps(fps);
        hud.setDebug(player.debugText(fps, renderer.activeCount, lighting.clockText()) + `  mobs ${mobs.count}`);
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
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
