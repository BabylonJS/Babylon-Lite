// Scene 322 — BJS reference for the glTF export visualization test "GLTF Serializer KHR gpu instancing".
// Mirrors playground #1Q2BWN#10: TeapotsGalore.gltf is appended to a scene, exported to GLB, and the GLB is
// reloaded as a new scene (the one rendered) with its own camera and light. Reference image: glTFSerializerKhrGpuInstancing.png.
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";

// The harness installs a seeded Math.random before running the snippet.
let seed = 1;
Math.random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
};

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(location.search);
    const antialias = params.get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};
    SceneLoader.ShowLoadingScreen = false;

    const createScene = function () {
        // This creates a basic Babylon Scene object (non-mesh)
        const scene = new Scene(engine);

        const cameraLocation = new Vector3(0, 50, -100);
        const cameraTarget = Vector3.Zero();

        // This creates and positions a universal camera (non-mesh)
        const camera = new UniversalCamera("camera1", cameraLocation, scene);

        // This targets the camera to scene origin
        camera.setTarget(cameraTarget);

        // This attaches the camera to the canvas
        camera.attachControl(canvas, true);

        // This creates a light, aiming 0,1,0 - to the sky (non-mesh)
        const lightDirection = new Vector3(0, 1, 0);
        const light = new HemisphericLight("light", lightDirection, scene);

        // Default intensity is 1. Let's dim the light a small amount
        light.intensity = 0.7;

        return SceneLoader.AppendAsync("https://models.babylonjs.com/TeapotsGalore/", "TeapotsGalore.gltf", scene).then(() => {
            return GLTF2Export.GLBAsync(scene, "KHR_gpu_instancing2").then((r) => {
                const file = new File([r.glTFFiles["KHR_gpu_instancing2.glb"]!], "KHR_gpu_instancing2.glb");
                return SceneLoader.LoadAsync("file:", file, engine).then((outScene) => {
                    const outCamera = new UniversalCamera("camera1", cameraLocation.clone(), outScene);
                    outCamera.setTarget(cameraTarget.clone());
                    outCamera.attachControl(canvas, true);
                    const outLight = new HemisphericLight("light", lightDirection.clone(), outScene);
                    outLight.intensity = 0.7;
                    return outScene;
                });
            });
        });
    };

    const scene = await createScene();
    scene.useConstantAnimationDeltaTime = true;
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
});
