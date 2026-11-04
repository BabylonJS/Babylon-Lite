// BJS reference for scene 252 — StandardMaterial sphere deformed into a teardrop
// by a single position morph target.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { Scene } from "@babylonjs/core/scene";
import { SCENE252_MORPH_WEIGHT, scene252MorphDeltas } from "../shared/scene252-stdmorph.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, 1.15, 4, new Vector3(0, 0, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 10000;

    const light = new DirectionalLight("dir", new Vector3(0, -1, 0), scene);
    light.diffuse = new Color3(1, 0, 0);
    light.specular = new Color3(0, 1, 0);

    const sphere = MeshBuilder.CreateSphere("sphere", { segments: 32, diameter: 1 }, scene);

    const basePositions = new Float32Array(sphere.getVerticesData(VertexBuffer.PositionKind)!);
    const deltas = scene252MorphDeltas(basePositions);
    const abs = new Float32Array(basePositions.length);
    for (let i = 0; i < basePositions.length; i++) {
        abs[i] = basePositions[i]! + deltas[i]!;
    }

    const mgr = new MorphTargetManager(scene);
    const target = new MorphTarget("teardrop", SCENE252_MORPH_WEIGHT, scene);
    target.setPositions(abs);
    mgr.addTarget(target);
    sphere.morphTargetManager = mgr;

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
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
