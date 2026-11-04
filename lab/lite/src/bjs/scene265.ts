import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const MODEL_URL = "https://cx20.github.io/gltf-test/tutorialModels/EnvironmentTest/glTF-IBL/EnvironmentTest.gltf";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    // The glTF's EXT_lights_image_based extension installs scene.environmentTexture.
    await SceneLoader.AppendAsync("", MODEL_URL, scene);

    // Match loadEnvironment's image-processing defaults (the Lite extension sets these).
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;

    // Same auto-framing formula as Lite's createDefaultCamera; override angles to match.
    scene.createDefaultCamera(true, true, true);
    const camera = scene.activeCamera as ArcRotateCamera;
    camera.alpha = Math.PI / 2;
    camera.beta = Math.PI / 2.5;

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.camAlpha = String(camera.alpha);
    canvas.dataset.camRadius = String(camera.radius);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
