// BJS reference for scene 202 — floating-origin point light.
//
// Mirrors lab/lite/src/lite/scene202.ts exactly. The ONE intended
// substrate difference is `useLargeWorldRendering: true` on the engine,
// which enables BJS's high-precision-matrix + floating-origin mode. Under
// that mode BJS subtracts `scene.floatingOriginOffset` (the active camera
// position) from the point light's `vLightData` position so the GPU sees
// an eye-relative light position — the exact behaviour scene202.ts asserts
// for Lite.
//
// IMPORTANT: every geometry/material/camera/light parameter below MUST stay
// in sync with lab/lite/src/lite/scene202.ts.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

/** Mirrors `OFFSET` in lab/lite/src/lite/scene202.ts. */
const OFFSET = 5_000_000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, useLargeWorldRendering: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);

    const cam = new ArcRotateCamera("cam", Math.PI / 4, Math.PI / 3, 14, new Vector3(OFFSET, 1, OFFSET), scene);
    cam.minZ = 0.5;
    cam.maxZ = 500;
    cam.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.15;

    const point = new PointLight("point", new Vector3(OFFSET + 4, 6, OFFSET - 2), scene);
    point.diffuse = new Color3(1, 0.95, 0.8);
    point.specular = new Color3(1, 1, 1);
    point.range = 100;
    point.intensity = 1.0;

    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40, subdivisions: 1 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.3, 0.3, 0.34);
    groundMat.specularColor = new Color3(0.2, 0.2, 0.2);
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);

    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const box = MeshBuilder.CreateBox(`box_${i}_${j}`, { size: 1 }, scene);
            const boxMat = new StandardMaterial(`boxMat_${i}_${j}`, scene);
            boxMat.diffuseColor = new Color3(0.35 + (i / 2) * 0.5, 0.4, 0.35 + (j / 2) * 0.5);
            boxMat.specularColor = new Color3(0.5, 0.5, 0.5);
            box.material = boxMat;
            box.position.set(OFFSET + (i - 1) * 5, 1, OFFSET + (j - 1) * 5);
        }
    }

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 3, segments: 32 }, scene);
    const sphereMat = new StandardMaterial("sphereMat", scene);
    sphereMat.diffuseColor = new Color3(0.8, 0.8, 0.85);
    sphereMat.specularColor = new Color3(0.9, 0.9, 0.9);
    sphere.material = sphereMat;
    sphere.position.set(OFFSET, 2.5, OFFSET);

    engine.runRenderLoop(() => scene.render());

    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - __initStart);
        canvas.dataset.offset = String(OFFSET);
        canvas.dataset.useLargeWorldRendering = "true";
        canvas.dataset.ready = "true";
    });
})();
