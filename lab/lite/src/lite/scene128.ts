// Scene 128 — Gaussian Splatting Depth Rendering (alpha-blended) (Lite).
// Port of playground https://playground.babylonjs.com/#V80DRL#19.
//
// Same as scene 127 but uses `gsAlphaBlendedDepthFragment` instead of
// `gsLinearDepthFragment`: each GS splat fragment writes
// `(d, d, d, gaussianAlpha)` so the existing GS pipeline alpha-blends a
// soft-edged depth visualisation matching BJS `depthRenderer.alphaBlendedDepth = true`.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createLinearDepthMaterial,
    createSceneContext,
    createSphere,
    gsAlphaBlendedDepthFragment,
    loadSplat,
    registerScene,
    startEngine,
} from "babylon-lite";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat";
const NEAR = 0.03;
const FAR = 15;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 1, g: 1, b: 1, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 10, { x: 0, y: 1, z: 0 });
    camera.nearPlane = NEAR;
    camera.farPlane = FAR;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const depthMaterial = createLinearDepthMaterial({ near: NEAR, far: FAR });

    const box = createBox(engine, 2);
    box.position.x = -2;
    box.material = depthMaterial;
    addToScene(scene, box);

    const sphere = createSphere(engine, { diameter: 2 });
    sphere.position.x = 2;
    sphere.material = depthMaterial;
    addToScene(scene, sphere);

    const ground = createGround(engine, { width: 6, height: 6 });
    ground.position.y = -1;
    ground.material = depthMaterial;
    addToScene(scene, ground);

    const splat = await loadSplat(scene, SPLAT_URL, [gsAlphaBlendedDepthFragment]);
    splat.position.y = 3;
    splat.position.z = 0;

    await registerScene(scene);
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
