// Scene 316 — BJS reference for the glTF export "Negative World Matrix" test.
// Mirrors playground #KX53VK#88 (Babylon.js visualization tests "GLTF Serializer with Negative World Matrix
// (left handed, once)" and "(left handed, twice)"; reference image glTFSerializerNegativeWorldMatrix.png):
// four vertex-colored triangles (CCW / CW winding, two under a negatively scaled + rotated parent) exported with
// GLTF2Export and reloaded `iterations` times. `?iterations=2` selects the second test; default is the first.
// The two right-handed tests are not ported (Babylon Lite has no right-handed scenes).
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Light } from "@babylonjs/core/Lights/light";
import { LoadAssetContainerAsync, SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";
import "@babylonjs/loaders/glTF";

// Babylon.js visualization harness: seeded Math.random.
let seed = 1;
Math.random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
};

// Test variant (config `replace`): `//options//` -> `useRightHandedSystem = false; iterations = 1|2;`
const params = new URLSearchParams(location.search);
const useRightHandedSystem = false;
const iterations = Number(params.get("iterations") ?? "1");

const positions = {
    CCW: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    CW: [0, 0, 0, 0, 1, 0, 1, 0, 0],
};
const colors = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1];
const indices = [0, 1, 2];

function clear(scene: Scene) {
    scene.meshes.slice().forEach((mesh) => {
        mesh.dispose(false, true);
    });
}

function createTriangle(scene: Scene, name: string, x: number, y: number, z: number, sideOrientation: "CCW" | "CW", addInvertedParent: boolean) {
    let parent: Mesh | null = null;
    if (addInvertedParent) {
        parent = new Mesh("InvertNode", scene);
        parent.scaling.z = -1;
        parent.rotation.y = Math.PI;
    }
    const mesh = new Mesh(name, scene, parent);
    mesh.position.set(x, y, z);

    const vertexData = new VertexData();
    vertexData.positions = positions[sideOrientation];
    vertexData.colors = colors;
    vertexData.indices = indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(vertexData.positions, indices, normals, { useRightHandedSystem: scene.useRightHandedSystem === (sideOrientation === "CCW") });
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);

    const material = new PBRMaterial("material_" + name, scene);
    material.metallic = 0;
    material.roughness = 1;
    material.sideOrientation = sideOrientation === "CCW" ? Material.CounterClockWiseSideOrientation : Material.ClockWiseSideOrientation;
    mesh.material = material;
}

async function exportThenImportAsync(scene: Scene) {
    const shouldExportNode = (node: unknown) => !(node instanceof Light);
    const response = await GLTF2Export.GLBAsync(scene, "geometry", { shouldExportNode });

    clear(scene);

    const blob = response.files["geometry.glb"] as Blob;
    const file = new File([blob], "geometry.glb");

    const container = await LoadAssetContainerAsync(file, scene);
    container.addAllToScene();
}

async function createScene(engine: WebGPUEngine, canvas: HTMLCanvasElement) {
    const scene = new Scene(engine);
    scene.useRightHandedSystem = useRightHandedSystem;

    const camera = new ArcRotateCamera("Camera", -Math.PI / 2, Math.PI / 2, 4, new Vector3(0, 0.5, 0), scene);
    camera.attachControl(canvas, true);

    new DirectionalLight("Light", new Vector3(0, 0, 1), scene);

    createTriangle(scene, "CCW", -1, 1, 0, "CCW", false);
    createTriangle(scene, "CW", 1, 1, 0, "CW", false);
    createTriangle(scene, "CCW_Inverted", -1, -1, 0, "CCW", true);
    createTriangle(scene, "CW_Inverted", 1, -1, 0, "CW", true);

    for (let i = 0; i < iterations; i++) {
        await exportThenImportAsync(scene);
    }
    return scene;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const antialias = params.get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};

    const scene = await createScene(engine, canvas);
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
