// Babylon.js reference for scene 279: fixed-topology update and colored thin instances.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";

const INITIAL = [[new Vector3(-1, -0.6, 0), new Vector3(-0.35, 0.75, 0), new Vector3(0.35, -0.05, 0), new Vector3(1, 0.65, 0)]];
const UPDATED = [[new Vector3(-1.1, -0.8, 0), new Vector3(-0.25, 0.95, 0), new Vector3(0.25, -0.15, 0), new Vector3(1.1, 0.8, 0)]];
const INSTANCE_POSITIONS = [
    [-3.6, 1.5, 0],
    [0, 1.5, 0],
    [3.6, 1.5, 0],
    [-1.8, -1.7, 0],
    [1.8, -1.7, 0],
] as const;

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.025, 0.05, 1);
    let mesh = MeshBuilder.CreateLineSystem("updated-instanced-lines", { lines: INITIAL, updatable: true, useVertexAlpha: true }, scene);
    mesh = MeshBuilder.CreateLineSystem("updated-instanced-lines", { lines: UPDATED, instance: mesh }, scene);

    const matrices = new Float32Array(INSTANCE_POSITIONS.length * 16);
    for (let i = 0; i < INSTANCE_POSITIONS.length; i++) {
        const [x, y, z] = INSTANCE_POSITIONS[i]!;
        Matrix.Translation(x, y, z).copyToArray(matrices, i * 16);
    }
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
    mesh.thinInstanceSetBuffer("color", new Float32Array([1, 0.2, 0.2, 0.9, 0.2, 1, 0.35, 0.75, 0.2, 0.55, 1, 0.65, 1, 0.75, 0.15, 0.55, 0.85, 0.25, 1, 0.45]), 4, true);

    scene.activeCamera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 12, Vector3.Zero(), scene);
    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => engineWithDrawCalls._drawCalls?.fetchNewFrame?.());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.updated = "true";
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
