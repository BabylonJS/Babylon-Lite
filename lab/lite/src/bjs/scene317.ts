// Scene 317 — BJS reference for the glTF export "Shared Buffer Conversions" test.
// Mirrors playground #KX53VK#85 (Babylon.js visualization test "GLTF Serializer Shared Buffer Conversions";
// reference image glTFSerializerSharedBufferConversions.png): two meshes share one vertex-colored Geometry,
// exported with GLTF2Export and reloaded. The test sets `meshCount = 2` (default in the snippet is 3).
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Light } from "@babylonjs/core/Lights/light";
import { LoadAssetContainerAsync, SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
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

let meshCount = 3; // Since conversions often involve negating signs, try this with odd and even numbers of meshes
meshCount = 2; // test option: `//options//` -> `meshCount = 2;`

function clear(scene: Scene) {
    scene.meshes.slice().forEach(function (mesh) {
        mesh.dispose(false, true);
    });
}

const positions = [
    // CCW
    0, 0, 0, 1, 0, 0, 0, 1, 0,
];

const colors = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1];

const indices = [0, 1, 2];

const normals: number[] = [];
VertexData.ComputeNormals(positions, indices, normals);

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const antialias = new URLSearchParams(location.search).get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};

    function createGeometry() {
        const geometry = new Geometry("shared");
        geometry.setVerticesBuffer(new VertexBuffer(engine, positions, VertexBuffer.PositionKind));
        geometry.setVerticesBuffer(new VertexBuffer(engine, colors, VertexBuffer.ColorKind));
        geometry.setVerticesBuffer(new VertexBuffer(engine, normals, VertexBuffer.NormalKind));
        geometry.setIndices(indices);
        return geometry;
    }

    function createTriangle(scene: Scene, name: number, x: number, y: number, z: number, geometry: Geometry) {
        // Mesh
        const mesh = new Mesh(String(name), scene);
        mesh.position.set(x, y, z);
        geometry.applyToMesh(mesh);

        // Material
        const material = new PBRMaterial("material_" + name, scene);
        material.metallic = 0;
        material.roughness = 1;
        mesh.material = material;
    }

    async function exportThenImportAsync(scene: Scene, toFile: boolean) {
        const shouldExportNode = (node: unknown) => !(node instanceof Light);
        const response = await GLTF2Export.GLBAsync(scene, "geometry", { shouldExportNode });

        clear(scene);

        const blob = response.files["geometry.glb"] as Blob;
        const file = new File([blob], "geometry.glb");

        if (toFile) {
            response.downloadFiles();
        }

        const container = await LoadAssetContainerAsync(file, scene);
        container.addAllToScene();
    }

    async function createScene() {
        // Initialize Scene
        const scene = new Scene(engine);
        const camera = new ArcRotateCamera("Camera", -Math.PI / 2, Math.PI / 2, 3, Vector3.Zero(), scene);
        camera.attachControl(canvas, true);
        new DirectionalLight("Light", new Vector3(0, 0, 1), scene);

        const geometry = createGeometry();

        for (let i = 0; i < meshCount; i++) {
            createTriangle(scene, i, -1 + (i % 2), -Math.floor(i / 2), 0, geometry);
        }

        await exportThenImportAsync(scene, false);
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
