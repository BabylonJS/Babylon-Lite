// BJS reference for scene 207 — floating-origin directional shadows (PCF).
//
// Mirrors lab/lite/src/lite/scene207.ts exactly. The ONE intended substrate
// difference is `useLargeWorldRendering: true` on the engine, which enables
// BJS's high-precision-matrix + floating-origin mode. Under that mode BJS
// subtracts the active camera position from world coordinates (including the
// shadow light-space transform), so shadows stay correct at large world
// coords — the exact behaviour scene207.ts asserts for Lite.
//
// IMPORTANT: every geometry/material/camera/light/shadow parameter below MUST
// stay in sync with lab/lite/src/lite/scene207.ts.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

/** Mirrors `OFFSET` in lab/lite/src/lite/scene207.ts. */
const OFFSET = 5_000_000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, useLargeWorldRendering: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);

    const cam = new ArcRotateCamera("cam", 1.0, 0.62, 15, new Vector3(OFFSET, 1, OFFSET), scene);
    cam.minZ = 0.5;
    cam.maxZ = 500;
    cam.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.2;

    const light = new DirectionalLight("dir", new Vector3(-1, -2, -1), scene);
    light.position = new Vector3(OFFSET + 20, 40, OFFSET + 20);
    light.diffuse = new Color3(1, 0.97, 0.9);
    light.intensity = 0.9;
    light.shadowMinZ = 1;
    light.shadowMaxZ = 200;

    const sg = new ShadowGenerator(1024, light);
    sg.usePercentageCloserFiltering = true;

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 3, segments: 32 }, scene);
    const sphereMat = new StandardMaterial("sphereMat", scene);
    sphereMat.diffuseColor = new Color3(0.8, 0.8, 0.85);
    sphereMat.specularColor = new Color3(0.4, 0.4, 0.4);
    sphere.material = sphereMat;
    sphere.position.set(OFFSET, 2, OFFSET);
    sg.addShadowCaster(sphere);

    const boxPositions: [number, number][] = [
        [-5, -4],
        [5, 4],
        [-4, 5],
    ];
    for (let i = 0; i < boxPositions.length; i++) {
        const [dx, dz] = boxPositions[i]!;
        const box = MeshBuilder.CreateBox(`box_${i}`, { size: 2 }, scene);
        const boxMat = new StandardMaterial(`boxMat_${i}`, scene);
        boxMat.diffuseColor = new Color3(0.35 + i * 0.2, 0.45, 0.7 - i * 0.15);
        boxMat.specularColor = new Color3(0.3, 0.3, 0.3);
        box.material = boxMat;
        box.position.set(OFFSET + dx, 1, OFFSET + dz);
        sg.addShadowCaster(box);
    }

    const ground = MeshBuilder.CreateGround("ground", { width: 100, height: 100, subdivisions: 1 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.45, 0.45, 0.5);
    groundMat.specularColor = new Color3(0, 0, 0);
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);
    ground.receiveShadows = true;

    engine.runRenderLoop(() => scene.render());

    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - __initStart);
        canvas.dataset.offset = String(OFFSET);
        canvas.dataset.useLargeWorldRendering = "true";
        canvas.dataset.ready = "true";
    });
})();
