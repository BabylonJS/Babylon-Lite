// Babylon.js reference for Scene 112: Flight Helmet KTX2 / KHR_texture_basisu.

import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const ASSET_ROOT = "https://raw.githubusercontent.com/BabylonJS/Assets/master/meshes/FlightHelmetKTX/";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    await SceneLoader.ImportMeshAsync("", ASSET_ROOT, "FlightHelmet.gltf", scene);

    scene.createDefaultCameraOrLight(true, true, true);
    (scene.activeCamera as ArcRotateCamera).alpha = Math.PI / 2;

    const envTex = await new Promise<CubeTexture>((resolve) => {
        const tex = new CubeTexture(
            "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
            scene,
            null,
            false,
            null,
            function onLoad() {
                resolve(tex);
            },
            null,
            undefined,
            true
        );
    });
    scene.environmentTexture = envTex;
    scene.createDefaultEnvironment({ createSkybox: true, createGround: true, skyboxSize: 1000 });
    for (const mat of scene.materials as Array<{ enableNoise?: boolean }>) {
        if ("enableNoise" in mat) {
            mat.enableNoise = false;
        }
    }

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
    const cam = scene.activeCamera as ArcRotateCamera;
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
