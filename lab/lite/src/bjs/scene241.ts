import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    await SceneLoader.AppendAsync("", "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/AnimationPointerUVs/glTF/AnimationPointerUVs.gltf", scene);

    scene.createDefaultEnvironment({ createGround: false, createSkybox: false });
    scene.imageProcessingConfiguration.toneMappingEnabled = false;
    scene.imageProcessingConfiguration.exposure = 1.0;
    scene.imageProcessingConfiguration.contrast = 1.0;

    const camera = new ArcRotateCamera("camera", 1.5707963, 1.5707963, 31.48, new Vector3(-0.113, 0.537, -0.031), scene);
    camera.fov = 0.8;
    camera.minZ = 31.48 * 0.01;
    camera.maxZ = 31.48 * 1000;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        if (!isNaN(seekTimeParam) && frameCount === 10 && !seekDone) {
            scene.animationGroups.forEach((g) => {
                const range = g.to - g.from;
                const frame = range > 0 ? g.from + ((seekTimeParam * 60 - g.from) % range) : g.from;
                g.goToFrame(frame);
            });
            scene.animatables.forEach((a) => a.pause());
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });
    engine.getDeltaTime = function () { return 16; };
    scene.useConstantAnimationDeltaTime = true;

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    const cam = scene.activeCamera as ArcRotateCamera;
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = String(cam.target.x) + "," + String(cam.target.y) + "," + String(cam.target.z);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
