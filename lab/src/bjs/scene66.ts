// BJS reference for scene 66 — mirrors PG M5VQE9#45 but with deterministic
// scramble deltas so parity is reproducible. Uses the same local AT7YY5#6 NME
// data as the Lite scene.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import "@babylonjs/core/Materials/Node/Blocks";
import { SCENE66_MORPH_PERIOD_MS, getScene66Nme, sphereScrambleDeltas } from "../shared/scene66-nme.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", 1.14, 0.95, 10, Vector3.Zero(), scene);
    cam.minZ = 1;
    cam.maxZ = 1000;

    const light = new DirectionalLight("light", new Vector3(1, -1, 1), scene);
    light.intensity = 0.7;
    light.shadowMinZ = -10;
    light.shadowMaxZ = 10;

    const sg = new ShadowGenerator(1024, light);
    sg.usePercentageCloserFiltering = true;
    sg.transparencyShadow = true;

    const sphere = Mesh.CreateSphere("sphere", 16, 2, scene, true);
    sphere.position.y = 1;
    sphere.position.x = -1.2;

    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.position.y = 1;
    box.position.x = 1.2;

    const ground = MeshBuilder.CreateGround("ground", { width: 6, height: 6 }, scene);
    ground.receiveShadows = true;

    sg.addShadowCaster(sphere);
    sg.addShadowCaster(box);

    // Load + build the local NME.
    const { json } = await getScene66Nme();
    const nm = NodeMaterial.Parse(json, scene);
    nm.build(false);
    sphere.material = nm;
    box.material = nm;
    ground.material = nm;

    // Morph target: absolute positions = base + deterministic scramble deltas.
    const basePositions = sphere.getVerticesData(VertexBuffer.PositionKind)!;
    const vertexCount = basePositions.length / 3;
    const deltas = sphereScrambleDeltas(vertexCount);
    const abs = new Float32Array(basePositions.length);
    for (let i = 0; i < basePositions.length; i++) {
        abs[i] = basePositions[i]! + deltas[i]!;
    }
    const mgr = new MorphTargetManager(scene);
    const freeze = new URLSearchParams(location.search).has("freeze");
    const target = new MorphTarget("scramble", freeze ? 1 : 0, scene);
    target.setPositions(abs);
    mgr.addTarget(target);
    sphere.morphTargetManager = mgr;

    const t0 = performance.now();
    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (!freeze) {
            const t = (performance.now() - t0) / SCENE66_MORPH_PERIOD_MS;
            const s = Math.sin(t * Math.PI * 2);
            target.influence = s * s;
        }
        if (eng._drawCalls) eng._drawCalls.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
