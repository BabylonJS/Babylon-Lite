// Scene 212 — Khronos DispersionTest — Babylon.js reference
// glTF KHR_materials_dispersion sample asset (CC-BY-4.0, AGI / Ed Mackey).
// A 5×5 grid of transmissive prisms (varying IOR × dispersion) over a cloth
// backdrop. Exercises KHR_materials_transmission + _volume + _ior + _dispersion.
// Camera pinned face-on so the golden is deterministic; the identical pose is
// mirrored in lab/lite/src/lite/scene212.ts. Values are NOT tuned to match Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const MODEL_ROOT = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DispersionTest/glTF-Binary/";
const MODEL_FILE = "DispersionTest.glb";
const ENV_URL = "https://assets.babylonjs.com/environments/studio.env";

const CAM = { alpha: Math.PI / 2, beta: Math.PI / 2, radius: 0.13, target: new Vector3(0, 0, 0), fov: 0.8 };

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

    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
    scene.createDefaultSkybox(scene.environmentTexture, true, (cam.maxZ - cam.minZ) / 2, 0.3, false);

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
