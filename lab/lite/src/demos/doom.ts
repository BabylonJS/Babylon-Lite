/**
 * DOOM demo — Phase 1: faithful map rendering.
 *
 * Fetches the Freedoom IWAD (BSD-licensed free game data, lazy-loaded as a static
 * asset — never bundled into JS), parses it clean-room from the publicly documented
 * WAD format, builds the first level's geometry, and renders it with a palette +
 * COLORMAP material so it reproduces the original engine's banded light look.
 *
 * Controls: arrow keys move/turn, comma/period (or Alt+arrows) strafe, Shift to run,
 * Space to use (open doors / activate switches / lifts).
 */

import { createEngine, createSceneContext, registerScene, startEngine } from "babylon-lite";
import { buildDoomLevel } from "./doom/doom-level.js";

const WAD_URL = "/doom/freedoom1.wad";
const MAP_NAME = "E1M1";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const res = await fetch(WAD_URL);
    if (!res.ok) throw new Error(`Failed to fetch ${WAD_URL}: ${res.status}. Run \`pnpm fetch:freedoom\`.`);
    const wadBytes = await res.arrayBuffer();

    buildDoomLevel(engine, scene, wadBytes, MAP_NAME);

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
