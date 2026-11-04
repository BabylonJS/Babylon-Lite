// BJS reference for scene 250 — VirtualCity (cx20 gltf-test parity).
//
// Uses Babylon.js's own glTF loader to import VirtualCity's 14 embedded cameras
// (scene.cameras), then selects the one named "camera6" — glTF camera index 6,
// attached to node 116 (a chase camera riding an animated flying vehicle) — matching
// the Lite scene's `root.cameras[6]` selection. Frozen via `?seekTime=` for a
// deterministic golden (GUIDANCE §2c).
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
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

    await SceneLoader.AppendAsync("", "https://cx20.github.io/gltf-test/sampleModels/VirtualCity/glTF/VirtualCity.gltf", scene);

    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);
    const envTex = await new Promise<CubeTexture>((resolve) => {
        const tex = new CubeTexture("https://assets.babylonjs.com/environments/environmentSpecular.env", scene, null, false, null, function onLoad() { resolve(tex); }, null, undefined, true);
    });
    scene.environmentTexture = envTex;

    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;

    // glTF camera index 6 (unnamed in the source asset) is imported by BJS as "camera6".
    const camera = scene.cameras.find((c) => c.name === "camera6")!;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);
        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            scene.animationGroups.forEach((g) => g.goToFrame(seekFrame));
            scene.animatables.forEach((a) => a.pause());
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
