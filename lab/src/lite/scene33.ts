// Scene 33 — KHR_lights_punctual glTF test — matches Babylon #YG3BBF#54
// Loads LightsPunctualLamp.glb (KHR_lights_punctual + KHR_materials_transmission),
// default environment (IBL only), default camera flipped by +π, and frame-graph
// scene-texture transmission enabled.

import { addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadEnvironment, loadGltf, attachControl, registerScene, getFrameGraph, type RenderTask } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    (getFrameGraph(scene)._tasks[0] as RenderTask)._config.transmission = { copyCount: 1 };

    const asset = await loadGltf(engine, "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/LightsPunctualLamp/glTF-Binary/LightsPunctualLamp.glb");
    addToScene(scene, asset);

    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createDefaultCamera(scene);
    cam.alpha += Math.PI;
    attachControl(cam, canvas, scene);

    await registerScene(engine, scene);
    await startEngine(engine);
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
