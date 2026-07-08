// BJS reference for scene 264 — a scene clip plane must slice both the
// StandardMaterial sphere and the PBRMaterial sphere, exactly as Babylon.js
// applies `scene.clipPlane` to every material family automatically.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const CLIP_PLANE: readonly [number, number, number, number] = [0, 1, 0, 0];

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.035, 0.05, 1);
    scene.clipPlane = new Plane(CLIP_PLANE[0], CLIP_PLANE[1], CLIP_PLANE[2], CLIP_PLANE[3]);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.6, 9, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const stdSphere = MeshBuilder.CreateSphere("scene264-standard-sphere", { segments: 32, diameter: 2.4 }, scene);
    stdSphere.position = new Vector3(-2.2, 0, 0);
    const stdMat = new StandardMaterial("std-mat", scene);
    stdMat.diffuseColor = new Color3(0.95, 0.25, 0.15);
    stdMat.specularColor = new Color3(0.4, 0.4, 0.4);
    stdMat.specularPower = 48;
    stdSphere.material = stdMat;

    const pbrSphere = MeshBuilder.CreateSphere("scene264-pbr-sphere", { segments: 32, diameter: 2.4 }, scene);
    pbrSphere.position = new Vector3(2.2, 0, 0);
    const pbrMat = new PBRMaterial("pbr-mat", scene);
    pbrMat.albedoColor = new Color3(0.15, 0.55, 1.0);
    pbrMat.metallic = 0.2;
    pbrMat.roughness = 0.4;
    pbrMat.environmentIntensity = 0;
    pbrSphere.material = pbrMat;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    hemi.diffuse = new Color3(1.0, 1.0, 1.0);
    hemi.groundColor = new Color3(0.1, 0.1, 0.12);
    const dir = new DirectionalLight("dir", new Vector3(-0.4, -1, -0.3), scene);
    dir.position = new Vector3(4, 8, 5);
    dir.intensity = 0.8;
    dir.diffuse = new Color3(1.0, 0.95, 0.85);

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => {
        engineWithDrawCalls._drawCalls?.fetchNewFrame?.();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
