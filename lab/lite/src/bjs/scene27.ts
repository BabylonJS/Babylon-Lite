import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

// Model: Babylon.js Assets, meshes/shoe_variants.glb (CC BY 4.0).
const MODEL_URL = "https://assets.babylonjs.com/meshes/shoe_variants.glb";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    const result = await SceneLoader.ImportMeshAsync("", MODEL_URL, undefined, scene);

    const KHR = (await import("@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_variants")).KHR_materials_variants;
    KHR.SelectVariant(result.meshes[0]!, "beach");

    const cam = new ArcRotateCamera("cam", 2.372, 1, 0.5, new Vector3(0, 0.076, 0), scene);
    cam.minZ = 0.01;

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 5;

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
