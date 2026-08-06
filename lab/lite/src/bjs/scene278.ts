// Babylon.js reference for scene 278: uniform and per-point colored line systems.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const UNIFORM_LINES = [
    [new Vector3(-4.6, -2.1, 0), new Vector3(-4.6, 2.1, 0), new Vector3(-1.4, 2.1, 0), new Vector3(-1.4, -2.1, 0), new Vector3(-4.6, -2.1, 0)],
    [new Vector3(-4.2, -1.6, 0), new Vector3(-1.8, 1.6, 0)],
    [new Vector3(-4.2, 1.6, 0), new Vector3(-1.8, -1.6, 0)],
];

const COLOR_LINES = [
    [new Vector3(1.4, -2.1, 0), new Vector3(3, 2.2, 0), new Vector3(4.6, -2.1, 0), new Vector3(1.4, 0.5, 0), new Vector3(4.6, 0.5, 0), new Vector3(1.4, -2.1, 0)],
    [new Vector3(1.6, -1.5, 0), new Vector3(4.4, 1.6, 0)],
];

const COLOR_VALUES = [
    [
        new Color4(1, 0.2, 0.15, 0.9),
        new Color4(1, 0.85, 0.1, 0.75),
        new Color4(0.15, 0.9, 0.35, 0.65),
        new Color4(0.1, 0.75, 1, 0.55),
        new Color4(0.65, 0.25, 1, 0.45),
        new Color4(1, 0.2, 0.15, 0.9),
    ],
    [new Color4(0.2, 0.9, 1, 0.35), new Color4(1, 0.25, 0.75, 0.8)],
];

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.025, 0.035, 0.065, 1);
    const uniform = MeshBuilder.CreateLineSystem("uniform-lines", { lines: UNIFORM_LINES, useVertexAlpha: false }, scene);
    uniform.color = new Color3(0.25, 0.85, 1);
    MeshBuilder.CreateLineSystem("vertex-color-lines", { lines: COLOR_LINES, colors: COLOR_VALUES, useVertexAlpha: true }, scene);

    scene.activeCamera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 12, Vector3.Zero(), scene);
    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => engineWithDrawCalls._drawCalls?.fetchNewFrame?.());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
