// Scene 320 — BJS reference for the glTF export visualization test "GLTF Serializer KHR draco mesh compression".
// Mirrors playground #F8BF8N#3: Alien.gltf is exported with meshCompressionMethod "Draco", the exported nodes are
// disposed, and the GLB is loaded back into the same scene. Reference image: glTFSerializerKhrDracoMeshCompression.png.
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import { Light } from "@babylonjs/core/Lights/light";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import type { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";
import type { IExportOptions } from "@babylonjs/serializers/glTF/2.0";

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

    const roundtrip = true;
    const exportFileName = "exported";
    const exportOptions: IExportOptions = {
        shouldExportNode: (node: Node) => !(node instanceof Light || node instanceof Camera),
        meshCompressionMethod: "Draco",
    };

    const exportThenImportAsync = async function (scene: Scene) {
        const glbData = await GLTF2Export.GLBAsync(scene, exportFileName, exportOptions);
        const file = new File([glbData.files[exportFileName + ".glb"]!], exportFileName + ".glb");
        scene
            .getNodes()
            .slice()
            .forEach((node) => {
                if (exportOptions.shouldExportNode!(node)) {
                    node.dispose();
                }
            });
        const container = await SceneLoader.LoadAssetContainerAsync("file:", file, scene);
        container.addAllToScene();
    };

    const createScene = async function () {
        const scene = new Scene(engine);
        await SceneLoader.AppendAsync("https://playground.babylonjs.com/scenes/Alien/", "Alien.gltf", scene);
        scene.createDefaultLight();
        scene.createDefaultCamera(true, true, true);
        (scene.activeCamera as ArcRotateCamera).alpha += Math.PI;
        (scene.activeCamera as ArcRotateCamera).radius = 1.25;
        if (roundtrip) {
            await exportThenImportAsync(scene);
        }
        return scene;
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
