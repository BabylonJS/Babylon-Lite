// Scene 324 — BJS reference for the glTF export "Rotation conversion" test.
// Mirrors playground #UK7FLI#1 (Babylon.js visualization test "GLTF Serializer Rotation conversion, left-handed";
// reference image glTFSerializerRotationConversionLH.png): six rotated parent/child box pairs exported with
// GLTF2Export (lights and cameras excluded) and reloaded. The snippet's own right-handed variant is not ported
// (Babylon Lite has no right-handed scenes).
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Light } from "@babylonjs/core/Lights/light";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Helpers/sceneHelpers";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";
import "@babylonjs/loaders/glTF";

// Babylon.js visualization harness: seeded Math.random.
let seed = 1;
Math.random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
};

const roundtrip = true;
const exportFileName = "exported";
const exportOptions = {
    shouldExportNode: (node: unknown) => !(node instanceof Light || node instanceof Camera),
};

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const antialias = new URLSearchParams(location.search).get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};

    function createRotatedParentChild(scene: Scene, xOffset: number, yOffset: number, parentQuaternion: Quaternion, childQuaternion: Quaternion) {
        const parent = new TransformNode("parent", scene);
        parent.position.set(xOffset - 1, yOffset - 0.5, 0);
        parent.rotationQuaternion = parentQuaternion;

        const child = MeshBuilder.CreateBox("child", { size: 1 }, scene);
        child.parent = parent;
        child.rotationQuaternion = childQuaternion;
    }

    async function exportThenImportAsync(scene: Scene) {
        const glb = await GLTF2Export.GLBAsync(scene, exportFileName, exportOptions);
        const file = new File([glb.glTFFiles[exportFileName + ".glb"] as Blob], exportFileName + ".glb");

        scene
            .getNodes()
            .slice()
            .forEach((node) => {
                if (exportOptions.shouldExportNode(node)) {
                    node.dispose();
                }
            });

        const container = await SceneLoader.LoadAssetContainerAsync("file:", file, scene);
        container.addAllToScene();
    }

    async function createScene() {
        const scene = new Scene(engine);
        scene.createDefaultLight();
        scene.createDefaultCamera(true, true, true);
        (scene.activeCamera as ArcRotateCamera).alpha += Math.PI;
        (scene.activeCamera as ArcRotateCamera).radius = 3;

        const Q = Quaternion.FromEulerAngles;
        createRotatedParentChild(scene, 0, 0, Q(-21, 42, 63), Q(0, 0, 0));
        createRotatedParentChild(scene, 0, 1, Q(0, 0, 0), Q(-98, 56, 43));
        createRotatedParentChild(scene, 1, 0, Q(-21, 42, 63), Q(34, -78, -121));
        createRotatedParentChild(scene, 1, 1, Q(-21, -100, -87), Q(-159, -80, 42));
        createRotatedParentChild(scene, 2, 0, Q(189, -33, -90), Q(-9, 56, 43));
        createRotatedParentChild(scene, 2, 1, Q(0, 360, 0), Q(-34, -180, 43));

        if (roundtrip) {
            await exportThenImportAsync(scene);
        }
        return scene;
    }

    const scene = await createScene();
    scene.useConstantAnimationDeltaTime = true;

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
});
