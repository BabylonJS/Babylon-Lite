// Scene 177 — PBR Iridescence Sphere — Babylon.js reference
// Port of https://playground.babylonjs.com/#2FDQT5#1505.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const ENV_URL = "https://playground.babylonjs.com/textures/environment.env";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    const camera = new ArcRotateCamera("camera1", 0, Math.PI / 2, 5, Vector3.Zero(), scene);
    camera.lowerRadiusLimit = 2;
    camera.upperRadiusLimit = 10;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    const environmentTexture = CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
    scene.createDefaultSkybox(environmentTexture, true, undefined, 0.3, true);

    const sphere = Mesh.CreateSphere("sphere1", 16, 2, scene);
    const pbr = new PBRMaterial("pbr", scene);
    sphere.material = pbr;
    pbr.albedoColor = new Color3(0.1, 0.1, 0.1);
    pbr.metallic = 1.0;
    pbr.roughness = 0.0;
    pbr.iridescence.isEnabled = true;

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
