// BJS reference for Scene 168 — two double-sided quads, one under a negative-scale node.
//
// Babylon.js handles the mirrored node by flipping the material's sideOrientation, so both quads
// shade identically. That is what makes this a useful golden: a build that fails to reverse the
// mirrored mesh's winding renders the pair inconsistently and misses the reference.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
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
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1.0);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 6, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);

    const envTex = CubeTexture.CreateFromPrefilteredData("https://assets.babylonjs.com/core/environments/environmentSpecular.env", scene);
    envTex.gammaSpace = false;
    scene.environmentTexture = envTex;
    scene.environmentIntensity = 1.0;

    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    // Matched to Lite's grading for this scene (Lite applies its own defaults after
    // loadEnvironment); tuned so the two agree on absolute brightness and the comparison is left
    // testing the winding, which is the point of the scene.
    scene.imageProcessingConfiguration.exposure = 0.805;
    scene.imageProcessingConfiguration.contrast = 1.0;

    await SceneLoader.ImportMeshAsync("", "/gltf-assets/MirroredDoubleSided/", "MirroredDoubleSided.gltf", scene);

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
