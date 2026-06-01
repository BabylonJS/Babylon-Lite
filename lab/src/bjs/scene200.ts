// BJS reference for scene 200 / 201 — High-Precision Matrix Jitter.
//
// Renders the same geometry as the Lite HPM jitter scenes (5×5 grid of
// unit boxes + central tall orange pillar at world OFFSET = 5e6) so the
// lab gallery can show a side-by-side BJS vs Lite comparison. BJS has
// no equivalent useHighPrecisionMatrix option, so the BJS render is a
// single Float32-only baseline used for visual reference only — the
// Lite parity specs do NOT compare against this output (they self-capture;
// see tests/parity/scenes/scene20{0,1}-...spec.ts).
//
// IMPORTANT: every parameter below MUST mirror lab/src/_shared/hpm-jitter-scene.ts
// so the golden capture stays in sync with the Lite scenes after geometry
// edits. The Lite shared builder is the source of truth.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

/** Mirrors `OFFSET` in lab/src/_shared/hpm-jitter-scene.ts. */
const OFFSET = 5_000_000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);

    // ArcRotate camera ~25m back from the grid centre — matches the Lite scene.
    const cam = new ArcRotateCamera("cam", Math.PI / 4, Math.PI / 3, 25, new Vector3(OFFSET, 1, OFFSET), scene);
    cam.minZ = 0.5;
    cam.maxZ = 500;
    cam.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.4;

    const dir = new DirectionalLight("dir", new Vector3(-0.4, -1, -0.2), scene);
    dir.diffuse = new Color3(1, 1, 1);
    dir.specular = new Color3(0.3, 0.3, 0.3);

    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40, subdivisions: 1 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.25, 0.25, 0.3);
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);

    // 5×5 grid of unit boxes, spacing 4m, centred on (OFFSET, 1, OFFSET).
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            const box = MeshBuilder.CreateBox(`box_${i}_${j}`, { size: 1 }, scene);
            const boxMat = new StandardMaterial(`boxMat_${i}_${j}`, scene);
            const r = 0.3 + (i / 4) * 0.6;
            const g = 0.4;
            const b = 0.3 + (j / 4) * 0.6;
            boxMat.diffuseColor = new Color3(r, g, b);
            boxMat.specularColor = new Color3(0.4, 0.4, 0.4);
            box.material = boxMat;
            box.position.set(OFFSET + (i - 2) * 4, 1, OFFSET + (j - 2) * 4);
        }
    }

    // Central pillar — taller and brighter (matches Lite scene exactly).
    const pillar = MeshBuilder.CreateBox("pillar", { size: 1 }, scene);
    const pillarMat = new StandardMaterial("pillarMat", scene);
    pillarMat.diffuseColor = new Color3(0.9, 0.5, 0.2);
    pillarMat.emissiveColor = new Color3(0.1, 0.05, 0.02);
    pillarMat.specularColor = new Color3(0.6, 0.6, 0.6);
    pillar.material = pillarMat;
    pillar.position.set(OFFSET, 2, OFFSET);
    pillar.scaling.set(0.8, 4, 0.8);

    engine.runRenderLoop(() => scene.render());

    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - __initStart);
        canvas.dataset.offset = String(OFFSET);
        canvas.dataset.ready = "true";
    });
})();
