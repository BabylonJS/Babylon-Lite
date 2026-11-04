import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
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
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);

    await SceneLoader.AppendAsync("", "https://cx20.github.io/gltf-test/tutorialModels/EmissiveFireflies/glTF/EmissiveFireflies.gltf", scene);

    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);
    const envTex = await new Promise<CubeTexture>((resolve) => {
        const tex = new CubeTexture("https://assets.babylonjs.com/environments/environmentSpecular.env", scene, null, false, null, function onLoad() { resolve(tex); }, null, undefined, true);
    });
    scene.environmentTexture = envTex;

    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;

    const camera = new ArcRotateCamera("camera", 1.5707963, 1.5707963, 5.63, new Vector3(0.063, 0.51, -0.079), scene);
    camera.fov = 0.8;
    camera.minZ = 5.63 * 0.01;
    camera.maxZ = 5.63 * 1000;
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
