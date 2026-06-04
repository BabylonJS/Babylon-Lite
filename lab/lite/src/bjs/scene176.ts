// Scene 176 — MosquitoInAmber — Babylon.js reference
// Faithful port of the Babylon.js Sandbox view
//   https://sandbox.babylonjs.com/?assetUrl=.../MosquitoInAmber.gltf
//        &environment=studio.env&skybox=true&autoRotate=true&cameraPosition=-0.14,0.005,0.03
// Mechanically mirrors packages/tools/sandbox/src/components/renderingZone.tsx:
//   - environmentTexture from the prefiltered studio.env
//   - createDefaultSkybox(env, true, (maxZ-minZ)/2, 0.3, false)
//   - tone mapping left disabled (no toneMapping URL param in the sandbox link)
// The camera is pinned to a fixed face-on pose (the angle autoRotate passes
// through) so the golden exercises KHR_materials_transmission; the identical
// pose is used by lab/lite/src/lite/scene176.ts. Values are NOT tuned to match Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const MODEL_ROOT = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/MosquitoInAmber/glTF/";
const MODEL_FILE = "MosquitoInAmber.gltf";
const ENV_URL = "https://assets.babylonjs.com/environments/studio.env";

const CAM = { alpha: 1.9445, beta: 1.5454, radius: 0.1458, target: new Vector3(0.00098, 0.0013, -0.00713), fov: 0.8 };

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    await SceneLoader.AppendAsync(MODEL_ROOT, MODEL_FILE, scene);

    const cam = new ArcRotateCamera("camera", CAM.alpha, CAM.beta, CAM.radius, CAM.target, scene);
    cam.fov = CAM.fov;
    cam.minZ = CAM.radius * 0.01;
    cam.maxZ = CAM.radius * 1000;
    cam.attachControl(canvas, true);
    scene.activeCamera = cam;

    // studio.env as IBL + visible HDR skybox (sandbox: skybox=true, blur 0.3).
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
    scene.createDefaultSkybox(scene.environmentTexture, true, (cam.maxZ - cam.minZ) / 2, 0.3, false);

    // Sandbox image processing for this link: tone mapping disabled, neutral exposure/contrast.
    scene.imageProcessingConfiguration.toneMappingEnabled = false;
    scene.imageProcessingConfiguration.exposure = 1.0;
    scene.imageProcessingConfiguration.contrast = 1.0;

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
