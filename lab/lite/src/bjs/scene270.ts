// Babylon.js reference for Scene 270: Introducing a new material family at runtime.
//
// Mirrors the Lite scene: a StandardMaterial-only scene starts rendering, then a PBR box is added from
// inside the render loop. BJS has no build-time material grouping, so the box simply appears — which is
// exactly the behaviour Lite is being held to.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const ADD_FRAME = 20;
const SETTLE_FRAMES = 150;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.1, 6, new Vector3(0, 0.9, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 50;
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 1.0;

    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.position = new Vector3(-1.2, 0.5, 0);
    const boxMat = new StandardMaterial("box-mat", scene);
    boxMat.diffuseColor = new Color3(0.85, 0.34, 0.2);
    boxMat.specularColor = Color3.Black();
    box.material = boxMat;

    const ground = MeshBuilder.CreateGround("ground", { width: 8, height: 8 }, scene);
    const groundMat = new StandardMaterial("ground-mat", scene);
    groundMat.diffuseColor = new Color3(0.2, 0.23, 0.27);
    groundMat.specularColor = Color3.Black();
    ground.material = groundMat;

    const pbrBox = MeshBuilder.CreateBox("pbr-box", { size: 1 }, scene);
    pbrBox.position = new Vector3(1.2, 0.5, 0);
    const pbrMat = new PBRMaterial("pbr-mat", scene);
    pbrMat.albedoColor = new Color3(0.2, 0.6, 1.0);
    pbrMat.metallic = 0.1;
    pbrMat.roughness = 0.4;
    pbrMat.environmentIntensity = 0;
    pbrBox.material = pbrMat;
    // Held back so the pre-add frames match Lite's, where the mesh is not in the scene yet.
    pbrBox.setEnabled(false);

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    let frame = 0;
    let added = false;
    scene.onBeforeRenderObservable.add(() => {
        frame++;
        if (!added && frame >= ADD_FRAME) {
            added = true;
            pbrBox.setEnabled(true);
            canvas.dataset.added = "true";
        }
        if (added && frame >= ADD_FRAME + SETTLE_FRAMES) {
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    canvas.dataset.loaded = "true";
    canvas.dataset.initMs = String(performance.now() - __initStart);
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
