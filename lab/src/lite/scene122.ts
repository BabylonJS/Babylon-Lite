// Scene 122 — Gaussian Splatting SOG parity (Lite).
// Loads a SOG (zipped meta.json + WebPs) cloud via loadSOG() and renders
// it with SH view-dependent shading. Mirrors the BJS playground
// QA2662#12; note that the BJS playground sets
// `mesh.rotation.x = Math.PI`, which loadSOG bakes into the row buffer +
// SH coefficients on our side so the mesh renders upright with identity
// rotation.

import { attachControl, createArcRotateCamera, createEngine, createSceneContext, loadSOG, registerScene, startEngine } from "babylon-lite";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/hornedlizard/hornedlizard.sog";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(4.6, 0.956, 3, { x: 0, y: -0.2, z: 0.2 });
    camera.nearPlane = 0.001;
    camera.farPlane = 1000;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const splat = await loadSOG(scene, SPLAT_URL);

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
