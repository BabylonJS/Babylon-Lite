// Scene 14: Flight Helmet — matches Babylon #BVK9I0#118
// Loads flightHelmet.glb with default environment + DDS cube skybox.
// Static PBR model, no animation.

import { addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadEnvironment, loadGltf, createHemisphericLight, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://assets.babylonjs.com/meshes/flightHelmet.glb"));
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
        skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
        skyboxSize: 1000,
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createDefaultCamera(scene);
    cam.alpha = Math.PI / 2;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

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
