// Scene 121 — Gaussian-Splatting `updateData` (Lite).
// Port of playground https://playground.babylonjs.com/#RKKCHG#15.
//
// Loads Halo_Believe.splat, waits for the first sort, then translates the
// first 30 000 splats' Y by -2 and calls `gs.updateData(...)`. The retained
// `gs.splatsData` ArrayBuffer is exposed on `window.__gs` so the
// uncommitted parity test can read it back and compare against the BJS
// reference scene byte-by-byte.

import { attachControl, createArcRotateCamera, createEngine, createSceneContext, loadSplat, registerScene, startEngine } from "babylon-lite";
import type { GaussianSplattingMesh } from "babylon-lite";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-1, 1, 10, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const gs: GaussianSplattingMesh = await loadSplat(scene, SPLAT_URL);

    await registerScene(engine, scene);
    await startEngine(engine);

    await gs.firstSortReady;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    // Translate the first 30 000 splats by Y -= 2 (mirrors the playground).
    // The .splat row layout is 32 bytes = 8 floats; Y is float index 1.
    const buf = gs.splatsData;
    const positions = new Float32Array(buf);
    for (let i = 0; i < 30000; i++) {
        positions[i * 8 + 1]! -= 2.0;
    }
    gs.updateData(buf);

    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    (window as unknown as { __gs: GaussianSplattingMesh }).__gs = gs;

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
