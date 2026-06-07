// BJS reference for scene 214 — deterministic CSM directional-shadow scene that
// mirrors the Lite scene214 (playground #KY0N7T#84): a field of 200 green
// torus-knot casters scattered across a 2000-unit area drops shadows onto a large
// Standard ground receiver, lit by a single DirectionalLight with a 4-cascade
// CascadedShadowGenerator (PCF5). A non-caster "Base" knot sits at the origin.
//
// Caster transforms come from a seeded mulberry32 PRNG (NOT Math.random) drawn in
// the SAME order as the Lite scene, so both engines place every knot identically.
// depthClamp is disabled and the light auto-fits cascade Z bounds
// (autoCalcShadowZBounds = true) so both engines fit identical cascade ranges
// without a GPU depth-clip feature — mirroring the Lite CSM path.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";

const SCENE_SIZE = 2000;
const NUM_CASTERS = 200;
const PRNG_SEED = 1337;

/** Deterministic mulberry32 PRNG — same algorithm/seed/draw-order as the Lite scene. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.5, 0.6, 0.75, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 3, SCENE_SIZE * 1.1, Vector3.Zero(), scene);
    cam.setTarget(Vector3.Zero());
    cam.minZ = 1;
    cam.maxZ = 10000;

    const light = new DirectionalLight("dir", new Vector3(0, -1, -1), scene);
    light.intensity = 0.8;
    light.autoCalcShadowZBounds = true;

    const ground = MeshBuilder.CreateGround("ground", { width: SCENE_SIZE, height: SCENE_SIZE }, scene);
    ground.receiveShadows = true;
    const groundMat = new StandardMaterial("groundMat", scene);
    ground.material = groundMat;

    // Shared green Standard material (only diffuseColor set; specular defaults kept).
    const knotMat = new StandardMaterial("knotMat", scene);
    knotMat.diffuseColor = Color3.Green();

    // Non-caster base knot at the origin (template mesh in the playground).
    const base = MeshBuilder.CreateTorusKnot("Base", { radius: 20, tube: 5 }, scene);
    base.material = knotMat;

    const sg = new CascadedShadowGenerator(1024, light);
    sg.numCascades = 4;
    sg.lambda = 0.5;
    sg.cascadeBlendPercentage = 0.1;
    sg.depthClamp = false;
    sg.stabilizeCascades = false;
    sg.bias = 0.00005;
    sg.filter = ShadowGenerator.FILTER_PCF;
    sg.filteringQuality = ShadowGenerator.QUALITY_HIGH;

    const rand = mulberry32(PRNG_SEED);
    for (let i = 0; i < NUM_CASTERS; i++) {
        const px = (rand() - 0.5) * SCENE_SIZE;
        const py = rand() * SCENE_SIZE * 0.25 + 1;
        const pz = (rand() - 0.5) * SCENE_SIZE;
        const ex = rand() * 3.14;
        const ey = rand() * 3.14;
        const ez = rand() * 3.14;

        const knot = MeshBuilder.CreateTorusKnot("knot" + i, { radius: 20, tube: 5 }, scene);
        knot.material = knotMat;
        knot.position = new Vector3(px, py, pz);
        // Set the quaternion explicitly (YawPitchRoll: yaw=y, pitch=x, roll=z) so the
        // orientation is identical to the Lite scene regardless of euler conventions.
        knot.rotationQuaternion = Quaternion.RotationYawPitchRoll(ey, ex, ez);
        sg.addShadowCaster(knot);
    }

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) eng._drawCalls.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
