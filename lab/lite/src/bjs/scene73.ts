import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";
import { getScene73Nme } from "../shared/scene73-nme.js";

const MODEL_ROOT = "/models/";
const MODEL_FILE = "CarbonFiberWheel.glb";
const ENV_URL = "https://assets.babylonjs.com/core/environments/environmentSpecular.env";

async function configureScene(scene: Scene): Promise<void> {
    const envTex = CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
    scene.environmentTexture = envTex;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;
    await new Promise<void>((resolve) => {
        if (envTex.isReady()) {
            resolve();
        } else {
            envTex.onLoadObservable.addOnce(() => resolve());
        }
    });
}

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const left = new Scene(engine);
    const right = new Scene(engine);
    left.clearColor = new Color4(0, 0, 0, 1);
    right.clearColor = new Color4(0, 0, 0, 1);
    right.autoClear = false;

    await Promise.all([configureScene(left), configureScene(right)]);

    const leftCamera = new ArcRotateCamera("Camera0", Math.PI / 2, Math.PI / 2, 1, Vector3.Zero(), left);
    leftCamera.minZ = 0.1;
    leftCamera.viewport = new Viewport(0, 0, 0.5, 1);

    const rightCamera = new ArcRotateCamera("Camera1", Math.PI / 2, Math.PI / 2, 1, Vector3.Zero(), right);
    rightCamera.minZ = 0.1;
    rightCamera.viewport = new Viewport(0.5, 0, 0.5, 1);

    await SceneLoader.ImportMeshAsync("", MODEL_ROOT, MODEL_FILE, left);
    await SceneLoader.ImportMeshAsync("", MODEL_ROOT, MODEL_FILE, right);

    const nodeMaterial = NodeMaterial.Parse(await getScene73Nme(), right);
    nodeMaterial.build(false);
    for (const mesh of right.meshes) {
        if (mesh.name !== "hdrSkyBox") {
            mesh.material = nodeMaterial;
        }
    }

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    left.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame?.();
    });
    right.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await Promise.all([left.whenReadyAsync(), right.whenReadyAsync()]);
    engine.runRenderLoop(() => {
        left.render();
        right.render();
    });
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => right.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
