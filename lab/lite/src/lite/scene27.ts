// Scene 27: Material Variants — selects the shoe's nondefault "beach" material.
// Model: Babylon.js Assets, meshes/shoe_variants.glb (CC BY 4.0).

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    loadGltf,
    attachControl,
    selectVariant,
    registerScene,
} from "babylon-lite";

const MODEL_URL = "https://assets.babylonjs.com/meshes/shoe_variants.glb";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const container = await loadGltf(engine, MODEL_URL);
    selectVariant(container, "beach");
    addToScene(scene, container);

    const cam = createArcRotateCamera(2.372, 1, 0.5, { x: 0, y: 0.076, z: 0 });
    cam.nearPlane = 0.01;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 5));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
