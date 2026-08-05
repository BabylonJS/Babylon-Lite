// Scene 35 — EXT_mesh_gpu_instancing glTF test — matches Babylon #YG3BBF#57
// Loads SimpleInstancing.glb (EXT_mesh_gpu_instancing), default environment
// (IBL only), default camera flipped by +π.

import { addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadEnvironment, loadGltf, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const data = canvas.dataset;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/SimpleInstancing/glTF-Binary/SimpleInstancing.glb"));

    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createDefaultCamera(scene);
    cam.alpha += Math.PI;
    attachControl(cam, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    data.drawCalls = String(engine.drawCallCount);
    data.camAlpha = String(cam.alpha);
    data.camBeta = String(cam.beta);
    data.camRadius = String(cam.radius);
    data.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    data.camFov = String(cam.fov);
    data.initMs = String(performance.now() - __initStart);
    data.ready = "true";
}

main().catch(console.error);
