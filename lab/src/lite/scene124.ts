// Scene 124 — Compressed PLY Gaussian Splatting parity (Lite).
// Loads a compressed-PLY (chunked + element sh) asset via loadSplat()
// — the dynamic-imported compressed parser kicks in automatically. SH
// rendering through the SH-aware pipeline. Mirrors playground U8O4EP#1
// (camera at (1.6, 0.5, 3), no rotation).

import { attachControl, createArcRotateCamera, createEngine, createSceneContext, loadSplat, registerScene, startEngine } from "babylon-lite";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/hornedlizard/small_hornedlizard.compressed.ply";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(1.6, 0.5, 3, { x: 0, y: -0.2, z: 0.2 });
    camera.nearPlane = 0.001;
    camera.farPlane = 1000;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const splat = await loadSplat(scene, SPLAT_URL);

    await registerScene(engine, scene);
    await startEngine(engine);

    await splat.firstSortReady;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
