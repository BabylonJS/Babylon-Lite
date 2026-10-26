// Scene 320 — BJS reference for the glTF export "Export GLTF Extension KHR_texture_transform" test.
// Mirrors playground #20OAV9#15148 (Babylon.js visualization test "Export GLTF Extension KHR_texture_transform"):
// four Standard-material planes with rotated / offset / scaled diffuse textures are exported with GLTF2Export
// (planes only) and re-imported into the same scene, 1.5 units below the originals.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ImportMeshAsync, SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Shaders/postprocess.vertex";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";
import "@babylonjs/loaders/glTF";

// Babylon.js visualization harness: seeded Math.random.
let seed = 1;
Math.random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
};

const TEXTURE_URL = "https://i.imgur.com/JbvoYlB.png";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(location.search);
    const antialias = params.get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};

    const scene = new Scene(engine);

    const light = new HemisphericLight("hemiLight", new Vector3(-1, 1, 0), scene);
    light.diffuse = new Color3(1, 1, 1);

    const mat0 = new StandardMaterial("mat0", scene);
    mat0.diffuseTexture = new Texture(TEXTURE_URL, scene);

    const mat1 = new StandardMaterial("mat1", scene);
    const tex1 = new Texture(TEXTURE_URL, scene);
    tex1.wAng = 0.3;
    tex1.uRotationCenter = 0;
    tex1.vRotationCenter = 0;
    mat1.diffuseTexture = tex1;

    const mat2 = new StandardMaterial("mat2", scene);
    const tex2 = new Texture(TEXTURE_URL, scene);
    tex2.uOffset = 0.1;
    tex2.vOffset = 0.4;
    mat2.diffuseTexture = tex2;

    const mat3 = new StandardMaterial("mat3", scene);
    const tex3 = new Texture(TEXTURE_URL, scene);
    tex3.uScale = 2;
    tex3.vScale = 3;
    mat3.diffuseTexture = tex3;

    const matList = [mat0, mat1, mat2, mat3];
    for (let i = 0; i < matList.length; i++) {
        const plane = MeshBuilder.CreatePlane("plane" + i, {}, scene);
        plane.material = matList[i]!;
        plane.position.x = 1.5 * i;
    }

    const camera = new ArcRotateCamera("Camera", -Math.PI / 2, Math.PI / 2, matList.length * 4, new Vector3((matList.length / 2) * 1.5, 0, 0), scene);
    camera.attachControl(canvas, true);
    scene.useConstantAnimationDeltaTime = true;

    await new Promise<void>((resolve) => scene.executeWhenReady(() => resolve(), true));
    const glb = await GLTF2Export.GLBAsync(scene, "fileName", { shouldExportNode: (node) => node.name.startsWith("plane") });
    for (const key in glb.files) {
        const file = new File([glb.files[key] as Blob], key);
        const meshes = (await ImportMeshAsync(file, scene)).meshes;
        for (const m of meshes) {
            if (m.name.startsWith("plane")) {
                m.position.y -= 1.5;
                m.name = "imported_" + m.name;
            }
        }
    }
    await new Promise<void>((resolve) => scene.executeWhenReady(() => resolve(), true));

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
});
