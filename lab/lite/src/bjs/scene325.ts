// Scene 325 — BJS reference for the glTF export "un/compressed texture roundtrip" test.
// Mirrors playground #8NTR5X#8 (Babylon.js visualization test "GLTF Serializer un/compressed texture roundtrip",
// options `roundtrip = true;`): PNG, JPEG and KTX2 textures created four ways on PBR planes, exported with
// GLTF2Export, reloaded with LoadSceneAsync, and shown with PBR debugMode 20 (albedo texture, gamma output).
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions";
import { SceneLoader, LoadSceneAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import { GetMimeType } from "@babylonjs/core/Misc/fileTools";
import { Tools } from "@babylonjs/core/Misc/tools";
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

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(location.search);
    const antialias = params.get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};

    let roundtrip = false;
    roundtrip = true;

    function createTexturedPlane(texture: Texture, position: number[], suffix: string) {
        const plane = MeshBuilder.CreatePlane("plane_" + suffix);
        plane.position.fromArray(position);
        const material = new PBRMaterial("material_" + suffix);
        material.albedoTexture = texture;
        material.metallic = 0;
        material.roughness = 1;
        plane.material = material;
        return plane;
    }

    let scene = new Scene(engine);
    scene.useDelayedTextureLoading = false;

    const textureSources = ["textures/down.png", "textures/grass.jpg", "textures/ktx2/sample_uastc.ktx2", "textures/palm.png"].map(
        (url) => "https://playground.babylonjs.com/" + url
    );

    const commonTextureOptions = { invertY: false, useSRGBBuffer: true };
    const textureCreationMethods: Array<(url: string) => Promise<Texture>> = [
        (url) =>
            new Promise<Texture>((resolve) => {
                const texture: Texture = new Texture(url, scene, { onLoad: () => resolve(texture), ...commonTextureOptions });
            }),
        (url) =>
            new Promise<Texture>((resolve) => {
                const texture = new Texture(null, scene, commonTextureOptions);
                texture.updateURL(url, undefined, () => resolve(texture));
            }),
        async (url) => {
            const texture = new Texture(null, scene, { mimeType: GetMimeType(url), ...commonTextureOptions });
            const data = await Tools.LoadFileAsync(url);
            return new Promise<Texture>((resolve) => {
                texture.updateURL("data:foo/" + url, data, () => resolve(texture));
            });
        },
        async (url) => {
            const texture = new Texture(null, scene, { mimeType: GetMimeType(url), ...commonTextureOptions });
            const data = await Tools.LoadFileAsync(url);
            return new Promise<Texture>((resolve) => {
                texture.updateURL("data:foo/" + Tools.RandomId(), data, () => resolve(texture));
            });
        },
    ];

    await Promise.all(
        textureSources.flatMap((url, i) =>
            textureCreationMethods.map(async (method, j) => {
                createTexturedPlane(await method(url), [j, i, 0], "original" + i + j);
            })
        )
    );

    if (roundtrip) {
        const blob = (await GLTF2Export.GLBAsync(scene, "test")).files["test.glb"] as Blob;
        scene.rootNodes.slice().forEach((node) => node.dispose(false, true));
        scene = await LoadSceneAsync(new File([blob], "test.glb"), engine);
    }

    scene.materials.forEach((material) => {
        (material as PBRMaterial).debugMode = 20;
    });

    const camera = new ArcRotateCamera(
        "Camera",
        -Math.PI / 2,
        Math.PI / 2,
        textureSources.length * 1.2,
        new Vector3(textureSources.length / 2 - 0.5, textureCreationMethods.length / 2 - 0.5, 0),
        scene
    );
    camera.attachControl(canvas, true);
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
