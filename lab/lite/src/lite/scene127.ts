// Scene 127 — Gaussian Splatting Depth Rendering (Lite).
// Port of playground https://playground.babylonjs.com/#V80DRL#12 — visualises
// linear camera-space depth as a grayscale image, with GS splats writing
// depth from inside the GS pipeline via the `gsLinearDepthFragment` plugin.
//
// Architecture difference from the PG: instead of running a DepthRenderer
// offscreen pass + customDepthPixelShader post-process, Lite writes the
// linear-depth visualisation directly to the swap-chain by assigning a
// linear-depth ShaderMaterial to every standard mesh and applying
// `gsLinearDepthFragment` to the GS mesh.  Visual output is identical.

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
    gsLinearDepthFragment,
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

    const splat = await loadSplat(scene, SPLAT_URL, [gsLinearDepthFragment]);
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
