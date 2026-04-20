// Scene 31 — KHR_materials_emissive_strength — matches Babylon #YG3BBF#52
// Loads EmissiveStrengthTest.glb (grid of emissive materials with varying
// KHR_materials_emissive_strength factors) against the default IBL environment
// (no ground, no skybox).

import { addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadEnvironment, loadGltf, attachControl } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(
        scene,
        await loadGltf(engine, "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/EmissiveStrengthTest/glTF-Binary/EmissiveStrengthTest.glb")
    );

    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createDefaultCamera(scene);
    cam.alpha += Math.PI;
    attachControl(cam, canvas, scene);

    await startEngine(engine, scene);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
