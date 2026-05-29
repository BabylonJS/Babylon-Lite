// BJS reference for scene 200 / 201 — High-Precision Matrix Jitter.
//
// Renders the same geometry as the Lite HPM jitter scenes (pillar +
// 4 satellites at world ~1e6) so the bundle build infrastructure has a
// reference target. BJS has no equivalent useHighPrecisionMatrix option,
// so the BJS render is a single Float32-only baseline used by the lab
// gallery for visual side-by-side comparison only — the Lite parity
// specs do NOT compare against this output (they self-capture; see
// tests/parity/scenes/scene20{0,1}-...spec.ts).
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const FAR_X = 1_000_000;
const FAR_Z = 1_000_000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", Math.PI / 4, Math.PI / 3, 8, new Vector3(FAR_X, 1, FAR_Z), scene);
    cam.minZ = 0.1;
    cam.maxZ = 200;
    cam.attachControl(canvas, true);

    new DirectionalLight("dir", new Vector3(-0.4, -1, -0.2), scene);

    const ground = MeshBuilder.CreateGround("ground", { width: 8, height: 8 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.2, 0.2, 0.25);
    ground.material = groundMat;
    ground.position.set(FAR_X, 0, FAR_Z);

    const pillar = MeshBuilder.CreateBox("pillar", { size: 1 }, scene);
    const pillarMat = new StandardMaterial("pillarMat", scene);
    pillarMat.diffuseColor = new Color3(0.8, 0.4, 0.2);
    pillarMat.emissiveColor = new Color3(0.1, 0.05, 0.02);
    pillarMat.specularColor = new Color3(0.6, 0.6, 0.6);
    pillar.material = pillarMat;
    pillar.position.set(FAR_X, 1.5, FAR_Z);
    pillar.scaling.set(0.6, 3, 0.6);

    for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2;
        const sat = MeshBuilder.CreateBox(`sat${i}`, { size: 1 }, scene);
        const satMat = new StandardMaterial(`satMat${i}`, scene);
        satMat.diffuseColor = new Color3(0.3, 0.7, 0.9);
        sat.material = satMat;
        sat.position.set(FAR_X + Math.cos(angle) * 2, 0.4, FAR_Z + Math.sin(angle) * 2);
        sat.scaling.set(0.4, 0.8, 0.4);
    }

    engine.runRenderLoop(() => scene.render());

    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - __initStart);
        canvas.dataset.ready = "true";
    });
})();
