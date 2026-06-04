// BJS reference for scene 203 — floating-origin spot light.
//
// Mirrors lab/lite/src/lite/scene203.ts exactly. The ONE intended substrate
// difference is `useLargeWorldRendering: true`, under which BJS subtracts
// `scene.floatingOriginOffset` (active camera position) from the spot
// light's `vLightData` position (leaving its direction untouched) — the
// exact behaviour scene203.ts asserts for Lite.
//
// IMPORTANT: keep every geometry/material/camera/light parameter in sync
// with lab/lite/src/lite/scene203.ts.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

/** Mirrors `OFFSET` in lab/lite/src/lite/scene203.ts. */
const OFFSET = 5_000_000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, useLargeWorldRendering: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);

    const cam = new ArcRotateCamera("cam", Math.PI / 4, Math.PI / 3.2, 18, new Vector3(OFFSET, 1, OFFSET), scene);
    cam.minZ = 0.5;
    cam.maxZ = 500;
    cam.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.1;

    const spot = new SpotLight("spot", new Vector3(OFFSET, 12, OFFSET), new Vector3(0, -1, 0), Math.PI / 4, 2, scene);
    spot.diffuse = new Color3(1, 0.95, 0.85);
    spot.specular = new Color3(1, 1, 1);
    spot.range = 100;
    spot.intensity = 1.5;

    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40, subdivisions: 1 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.32, 0.32, 0.36);
    groundMat.specularColor = new Color3(0.2, 0.2, 0.2);
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);

    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const box = MeshBuilder.CreateBox(`box_${i}`, { size: 1 }, scene);
        const boxMat = new StandardMaterial(`boxMat_${i}`, scene);
        boxMat.diffuseColor = new Color3(0.6, 0.45, 0.4);
        boxMat.specularColor = new Color3(0.5, 0.5, 0.5);
        box.material = boxMat;
        box.position.set(OFFSET + Math.cos(a) * 5, 0.5, OFFSET + Math.sin(a) * 5);
    }

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 3, segments: 32 }, scene);
    const sphereMat = new StandardMaterial("sphereMat", scene);
    sphereMat.diffuseColor = new Color3(0.8, 0.8, 0.85);
    sphereMat.specularColor = new Color3(0.9, 0.9, 0.9);
    sphere.material = sphereMat;
    sphere.position.set(OFFSET, 1.5, OFFSET);

    engine.runRenderLoop(() => scene.render());

    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - __initStart);
        canvas.dataset.offset = String(OFFSET);
        canvas.dataset.useLargeWorldRendering = "true";
        canvas.dataset.ready = "true";
    });
})();
