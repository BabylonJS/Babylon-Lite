// Babylon.js reference for Scene 268: Orthographic Camera Projection.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Scene } from "@babylonjs/core/scene";

const ORTHO_HALF_HEIGHT = 6;
const ROW_X = [-4, 4];
const DEPTHS = [-7, -3.5, 0, 3.5, 7];
const COLORS = [
    new Color3(0.85, 0.25, 0.25),
    new Color3(0.9, 0.6, 0.2),
    new Color3(0.35, 0.75, 0.4),
    new Color3(0.25, 0.55, 0.9),
    new Color3(0.65, 0.35, 0.85),
];

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.06, 0.07, 0.1, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2 + 0.4, Math.PI / 3, 30, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    // Lite derives the horizontal extent from the render aspect ratio; mirror that here so
    // both engines describe the same world-space view volume.
    const halfWidth = ORTHO_HALF_HEIGHT * (engine.getRenderWidth() / engine.getRenderHeight());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -halfWidth;
    camera.orthoRight = halfWidth;
    camera.orthoBottom = -ORTHO_HALF_HEIGHT;
    camera.orthoTop = ORTHO_HALF_HEIGHT;
    scene.activeCamera = camera;

    new HemisphericLight("light", new Vector3(0, 1, 0), scene);

    for (const x of ROW_X) {
        for (let i = 0; i < DEPTHS.length; i++) {
            const box = CreateBox("box", { size: 2 }, scene);
            box.position.set(x, 0, DEPTHS[i]!);
            const material = new StandardMaterial("box-mat", scene);
            material.diffuseColor = COLORS[i]!;
            material.specularColor = Color3.Black();
            box.material = material;
        }
    }

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.ready = "true";
})().catch(console.error);
