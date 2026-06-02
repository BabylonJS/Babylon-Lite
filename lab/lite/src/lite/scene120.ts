// Scene 120 — Gaussian Splatting parity (Lite).
// Loads https://assets.babylonjs.com/splats/Halo_Believe.ply via the
// new loadSplat() and waits for the first worker sort before flagging
// the canvas ready (so screenshots capture a meaningful image).

import { attachControl, createArcRotateCamera, createEngine, createSceneContext, loadSplat, registerScene, startEngine } from "babylon-lite";

const SPLAT_URL = "https://assets.babylonjs.com/splats/Halo_Believe.ply";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 6, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const splat = await loadSplat(scene, SPLAT_URL);

    await registerScene(engine, scene);
    await startEngine(engine);

    // Wait for the worker's first sort result to land — only then is the
    // splatIndex buffer in true back-to-front order.
    await splat.firstSortReady;
    // One more frame to let the freshly-sorted buffer be drawn.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
