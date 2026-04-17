import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    scene.environmentTexture = new CubeTexture("https://playground.babylonjs.com/textures/country.env", scene);

    scene.createDefaultSkybox(scene.environmentTexture!, false, 1000, 0, false);

    const camera0 = new ArcRotateCamera("Camera0", -Math.PI / 2, Math.PI / 2.7, 0.14, Vector3.Zero(), scene);
    camera0.setTarget(Vector3.Zero());
    camera0.attachControl(canvas, true);
    camera0.minZ = 0.01;

    const mat0 = new PBRMaterial("mat0", scene);
    mat0.metallic = 0.0;
    mat0.roughness = 0.8;
    mat0.useRoughnessFromMetallicTextureAlpha = false;
    mat0.useRoughnessFromMetallicTextureGreen = true;
    mat0.useMetallnessFromMetallicTextureBlue = true;
    mat0.albedoColor = new Color3(12 / 255, 60 / 255, 222 / 255);
    mat0.sheen.isEnabled = true;
    mat0.sheen.roughness = 0.5;
    mat0.sheen.texture = new Texture("https://playground.babylonjs.com/textures/fire.png", scene, false, false);

    await SceneLoader.ImportMeshAsync("", "https://models.babylonjs.com/cloth/", "cloth_meshV1.glb", scene);

    scene.meshes.forEach((m) => {
        if (m.name !== "hdrSkyBox") {
            m.material = mat0;
        }
    });

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

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    const cam = scene.activeCamera as ArcRotateCamera;
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
