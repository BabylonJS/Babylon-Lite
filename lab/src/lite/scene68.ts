// Scene 68: NME PBR core + ClearCoatBlock.
// Same scene as 67 (4 lights + env IBL + sphere) but the NME graph adds
// a glossy clear-coat layer on a dark navy base.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createHemisphericLight,
    createPointLight,
    createSpotLight,
    createDirectionalLight,
    attachControl,
    registerScene,
    parseNodeMaterialFromSnippet,
    loadEnvironment,
} from "babylon-lite";
import { SCENE68_NME_JSON } from "../shared/scene68-nme.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 7, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const hemi = createHemisphericLight([0, 1, 0], 1);
    addToScene(scene, hemi);
    const point = createPointLight([0, 5, -2], 1);
    addToScene(scene, point);
    const spot = createSpotLight([-0.5, 0, -2], [0, 0, 1], Math.PI / 2, 1, 1);
    addToScene(scene, spot);
    const dir = createDirectionalLight([1, -1, 1], 10);
    addToScene(scene, dir);

    const sphere = createSphere(engine, { segments: 32, diameter: 2 });
    const material = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE68_NME_JSON });
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
