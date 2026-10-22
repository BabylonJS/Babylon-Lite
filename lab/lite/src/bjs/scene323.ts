// Scene 323 — BJS reference for the glTF export "KHR punctual light" test.
// Mirrors playground #FLXW8B#27 (Babylon.js visualization test "GLTF Serializer KHR punctual light, left-handed";
// reference image glTFSerializerKHRPunctualLightLH.png): a directional, a point and a spot light with glTF falloff over
// a PBR ground; only the lights are exported with GLTF2Export, removed, and reloaded. The test sets
// `roundtrip = true; useRightHandedSystem = false;` (the right-handed test is not ported: Lite has no right-handed scenes).
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Light } from "@babylonjs/core/Lights/light";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";
import "@babylonjs/loaders/glTF";

// Babylon.js visualization harness: seeded Math.random.
let seed = 1;
Math.random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
};

let roundtrip = true;
let useRightHandedSystem = true;
const downloadGLTF = false;
roundtrip = true;
useRightHandedSystem = false; // test option: `//options//` -> `roundtrip = true; useRightHandedSystem = false;`

const shouldExportNode = (node: unknown) => node instanceof Light;
const exportFileName = "exported";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const antialias = new URLSearchParams(location.search).get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};

    function createCameraAndPlane(scene: Scene) {
        const camera = new ArcRotateCamera("camera", Math.PI / 2, Math.PI / 4, 8, Vector3.Zero(), scene);
        camera.attachControl(canvas, true);

        const ground = MeshBuilder.CreateGround("Ground", { width: 5, height: 5 });
        const mat = new PBRMaterial("mat");
        mat.roughness = 0.66;
        ground.material = mat;
    }

    function createLights(scene: Scene) {
        const directional = new DirectionalLight("directional", new Vector3(-1, -1, -1), scene);
        directional.intensity = 0.2;
        directional.falloffType = Light.FALLOFF_GLTF;

        const point = new PointLight("point", new Vector3(2, 2, 2), scene);
        point.falloffType = Light.FALLOFF_GLTF;

        const spot = new SpotLight("spot", new Vector3(-2, 2, -2), new Vector3(2, -2, 2), 30, 2, scene);
        spot.falloffType = Light.FALLOFF_GLTF;
    }

    async function exportThenImportAsync(scene: Scene) {
        const glbData = await GLTF2Export.GLBAsync(scene, exportFileName, { shouldExportNode });
        const file = new File([glbData.glTFFiles[exportFileName + ".glb"] as Blob], exportFileName + ".glb");

        if (downloadGLTF) {
            glbData.downloadFiles();
        }

        scene
            .getNodes()
            .slice()
            .forEach((node) => {
                if (shouldExportNode(node)) {
                    node.dispose();
                }
            });

        const container = await SceneLoader.LoadAssetContainerAsync("file:", file, scene);
        container.addAllToScene();
    }

    async function createScene() {
        const scene = new Scene(engine);
        scene.useRightHandedSystem = useRightHandedSystem;

        createCameraAndPlane(scene);
        createLights(scene);

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
