// Scene 125 — Gaussian Splatting bakeCurrentTransformIntoVertices (Lite).
// Port of playground https://playground.babylonjs.com/#GU7A98#0.

import {
    attachControl,
    bakeCurrentTransformIntoVertices,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    loadSplat,
    registerScene,
    startEngine,
} from "babylon-lite";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(4.57, 1.29, 18, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const splat = await loadSplat(scene, SPLAT_URL);

    splat.position.y = 1.7;
    splat.scaling.x = 10;
    splat.scaling.y = 10;
    splat.scaling.z = 10;
    splat.rotation.z = Math.PI * 0.75;
    splat.rotation.x = Math.PI * 0.25;
    bakeCurrentTransformIntoVertices(splat);

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
