// Scene 123 — Gaussian Splatting SPZ parity (Lite).
// Loads a gzipped SPZ cloud via loadSPZ() and renders it with SH
// view-dependent shading. Mirrors playground XSNFXP#12 — camera at
// (4.6, 0.956, 3). The BJS playground also sets
// `mesh.rotation.x = Math.PI`; loadSPZ bakes that correction into the row
// buffer + SH coefficients here so the mesh renders upright with identity
// rotation.

import { attachControl, createArcRotateCamera, createEngine, createSceneContext, loadSPZ, registerScene, startEngine } from "babylon-lite";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/hornedlizard/hornedlizard.spz";

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

    const splat = await loadSPZ(scene, SPLAT_URL);

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
