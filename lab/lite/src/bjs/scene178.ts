// Scene 178 — Khronos IridescenceAbalone — Babylon.js reference
// glTF KHR_materials_iridescence sample asset (CC-BY-4.0).

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const MODEL_ROOT = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/IridescenceAbalone/glTF-Binary/";
const MODEL_FILE = "IridescenceAbalone.glb";
const ENV_URL = "https://assets.babylonjs.com/environments/studio.env";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    await SceneLoader.AppendAsync(MODEL_ROOT, MODEL_FILE, scene);

    const camera = new ArcRotateCamera("camera", 1.2, 1.25, 1.0, Vector3.Zero(), scene);
    camera.fov = 0.7;
    camera.minZ = 0.01;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
    scene.createDefaultSkybox(scene.environmentTexture, true, 50, 0.3, false);
    scene.imageProcessingConfiguration.toneMappingEnabled = false;
    scene.imageProcessingConfiguration.exposure = 1.0;
    scene.imageProcessingConfiguration.contrast = 1.0;

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
