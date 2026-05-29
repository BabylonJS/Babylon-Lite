// Scene 87: NME IridescenceBlock + ImageProcessingBlock.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createHemisphericLight,
    createDirectionalLight,
    attachControl,
    registerScene,
    parseNodeMaterialFromSnippet,
    loadEnvironment,
} from "babylon-lite";
import { SCENE87_NME_JSON } from "../shared/scene87-nme.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.015, g: 0.015, b: 0.025, a: 1 };
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.toneMappingType = "standard";
    scene.imageProcessing.exposure = 0.85;
    scene.imageProcessing.contrast = 1.15;

    scene.camera = createArcRotateCamera(-Math.PI / 2.15, Math.PI / 2.15, 6.2, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.toneMappingType = "standard";
    scene.imageProcessing.exposure = 0.85;
    scene.imageProcessing.contrast = 1.15;

    const hemi = createHemisphericLight([0, 1, 0], 0.55);
    addToScene(scene, hemi);
    const dir = createDirectionalLight([0.45, -0.65, 0.35], 2.8);
    addToScene(scene, dir);

    const sphere = createSphere(engine, { segments: 64, diameter: 2.4 });
    const material = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE87_NME_JSON });
    (sphere as { material?: unknown }).material = material;
    addToScene(scene, sphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
