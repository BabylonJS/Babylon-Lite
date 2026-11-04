// Scene 35 — EXT_mesh_gpu_instancing glTF test — matches Babylon #YG3BBF#57
// Loads SimpleInstancing.glb (EXT_mesh_gpu_instancing), default environment
// (IBL only), default camera flipped by +π.

import { addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadEnvironment, loadGltf, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.querySelector("canvas")!;

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
    const { x, y, z } = cam.target;
    Object.assign(canvas.dataset, {
        drawCalls: engine.drawCallCount,
        camAlpha: cam.alpha,
        camBeta: cam.beta,
        camRadius: cam.radius,
        camTarget: `${x},${y},${z}`,
        camFov: cam.fov,
        initMs: performance.now() - __initStart,
        ready: true,
    });
}

main().catch(console.error);
