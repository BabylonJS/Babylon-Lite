// BJS reference for scene 254 — glTF Animation_SamplerType_01.
// Rotation animation whose sampler output quaternions are a normalized signed
// BYTE accessor (componentType 5120). Frozen at seekTime=2.0 (frame 120).

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

void (async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    // §1d: prevent the BJS loading overlay from compositing into the screenshot.
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("camera", Math.PI / 4, Math.PI / 3, 1.6, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.01;
    camera.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 1.0;

    const envTex = CubeTexture.CreateFromPrefilteredData("https://assets.babylonjs.com/core/environments/environmentSpecular.env", scene);
    envTex.gammaSpace = false;
    scene.environmentTexture = envTex;
    scene.environmentIntensity = 1.0;

    // Match loadEnvironment's image processing (GUIDANCE §1d).
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;

    await SceneLoader.ImportMeshAsync("", "/gltf-assets/Animation_SamplerType/", "Animation_SamplerType_01.gltf", scene);

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
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
