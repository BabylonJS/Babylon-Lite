// Scene 27: Material Variants — matches playground #C1QH9J#78
// Loads a refrigerator glTF with KHR_materials_variants, selects "White" variant.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createHemisphericLight, loadGltf, attachControl, selectVariant, registerScene } from "babylon-lite";

const MODEL_URL = "https://brave-engine-bucket.s3.ap-southeast-1.amazonaws.com/s3-public/assets/models/props/var_Refrigerator.glb";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const container = await loadGltf(engine, MODEL_URL);
    selectVariant(container, "White");
    addToScene(scene, container);

    const cam = createArcRotateCamera(2.372, 1, 5, { x: 0, y: 1, z: 0 });
    cam.nearPlane = 0.01;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 5));

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
