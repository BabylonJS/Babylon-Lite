// Scene 112: Flight Helmet KTX2 — glTF KHR_texture_basisu validation.

import { addToScene, attachControl, createDefaultCamera, createEngine, createHemisphericLight, createSceneContext, loadEnvironment, loadGltf, registerScene, startEngine } from "babylon-lite";
import { addDdsEnvironmentBackground } from "../../../packages/babylon-lite/src/material/pbr/background-dds-environment.js";
import { enablePbrOpaqueRefraction, usePbrOpaqueRefraction } from "../../../packages/babylon-lite/src/material/pbr/pbr-refraction-setup.js";

const MODEL_URL = "https://raw.githubusercontent.com/BabylonJS/Assets/master/meshes/FlightHelmetKTX/FlightHelmet.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    enablePbrOpaqueRefraction(scene, engine);

    const helmet = await loadGltf(engine, MODEL_URL);
    usePbrOpaqueRefraction(helmet);
    addToScene(scene, helmet);
    const groundTextureUrl = "https://assets.babylonjs.com/core/environments/backgroundGround.png";
    const skyboxUrl = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipGround: true,
        skipSkybox: true,
        skyboxSize: 1000,
        brdfUrl: "/brdf-lut.png",
    });
    addDdsEnvironmentBackground(scene, { groundTextureUrl, skyboxUrl, skyboxSize: 1000, enableNoise: false });

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
