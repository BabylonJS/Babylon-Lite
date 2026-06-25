// BJS reference for scene 261 — Temporal Anti-Aliasing.
//
// Three rotated boxes (sharp diagonal silhouette edges) lit by a hemispheric light,
// with Babylon.js' built-in TAARenderingPipeline accumulating sub-pixel-jittered
// frames into an anti-aliased image. Renders many frames so the accumulation
// converges, then freezes (deterministic golden) and reports ready.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import { TAARenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline";

const ACCUMULATION_FRAMES = 160;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    // antialias:false — TAA replaces MSAA; a multisampled backbuffer would diverge
    // from the single-sample TAA accumulation path.
    const engine = new WebGPUEngine(canvas, { antialias: false });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);

    const camera = new ArcRotateCamera("c", -Math.PI / 2, Math.PI / 2.4, 10, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    new HemisphericLight("light", new Vector3(0, 1, 0), scene);

    // Axis-angle quaternion (axis normalized), identical to the Lite scene, so the box
    // orientations match exactly regardless of Euler convention.
    const axisAngleQuat = (ax: number, ay: number, az: number, angle: number): Quaternion => {
        const len = Math.hypot(ax, ay, az) || 1;
        const s = Math.sin(angle / 2) / len;
        return new Quaternion(ax * s, ay * s, az * s, Math.cos(angle / 2));
    };

    const addBox = (color: Color3, x: number, axis: [number, number, number], angle: number): void => {
        const box: Mesh = MeshBuilder.CreateBox("box", { size: 2 }, scene);
        const mat = new StandardMaterial("mat", scene);
        mat.diffuseColor = color;
        mat.specularColor = new Color3(0, 0, 0);
        box.material = mat;
        box.position.x = x;
        box.rotationQuaternion = axisAngleQuat(axis[0], axis[1], axis[2], angle);
    };

    addBox(new Color3(0.85, 0.32, 0.22), -2.6, [1, 1, 0], 0.9);
    addBox(new Color3(0.3, 0.78, 0.4), 0, [0, 1, 1], 0.8);
    addBox(new Color3(0.32, 0.5, 0.9), 2.6, [1, 0.5, 0.5], 1.0);

    const taa = new TAARenderingPipeline("scene261-taa", scene, [camera], Constants.TEXTURETYPE_HALF_FLOAT);
    taa.samples = 8;
    taa.factor = 0.05;
    taa.disableOnCameraMove = false;
    taa.isEnabled = true;

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    for (let i = 0; i < ACCUMULATION_FRAMES; i++) {
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    }
    engine.stopRenderLoop();

    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
