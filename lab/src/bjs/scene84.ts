// BJS reference for scene 84 — parses the same NME fragment/screen JSON as Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { SCENE84_NME_JSON } from "../shared/scene84-nme.js";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 4, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 1.0;

    const material = NodeMaterial.Parse(SCENE84_NME_JSON, scene);
    material.build(false);

    const screenPlane = MeshBuilder.CreatePlane("screen-depth-plane", { width: 3.2, height: 2.2 }, scene);
    screenPlane.material = material;

    const backMat = new StandardMaterial("background", scene);
    backMat.disableLighting = true;
    backMat.emissiveColor = new Color3(0.02, 0.14, 0.55);
    const background = MeshBuilder.CreatePlane("depth-background", { width: 3.2, height: 2.2 }, scene);
    background.position.z = -0.2;
    background.material = backMat;

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
