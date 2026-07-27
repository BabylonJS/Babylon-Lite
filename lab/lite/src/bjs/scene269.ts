// BJS reference for scene 269 — setParent() on a mirrored glTF root.
// Same hierarchy as the Lite scene: the loader's `__root__` (negative determinant, RH->LH flip)
// is reparented under a user-created TransformNode via TransformNode.setParent(). Static.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const YAW = Math.PI / 7;

void (async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 4, Math.sqrt(800), new Vector3(0, 0, 0), scene);
    camera.minZ = 1;
    camera.maxZ = 1000;
    camera.attachControl(canvas, true);

    const envTex = CubeTexture.CreateFromPrefilteredData("https://assets.babylonjs.com/core/environments/environmentSpecular.env", scene);
    envTex.gammaSpace = false;
    scene.environmentTexture = envTex;
    scene.environmentIntensity = 1.0;

    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;

    const result = await SceneLoader.ImportMeshAsync("", "/gltf-assets/Node_NegativeScale/", "Node_NegativeScale_01.gltf", scene);
    const gltfRoot = result.transformNodes.find((n) => n.name === "__root__") ?? result.meshes.find((m) => m.name === "__root__")!;

    const newRoot = new TransformNode("newRoot", scene);
    newRoot.position.set(0, 2, -3);
    newRoot.rotationQuaternion = new Quaternion(0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2));
    newRoot.scaling.set(1.2, 1.2, 1.2);
    gltfRoot.setParent(newRoot);

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
