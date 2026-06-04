// BJS reference for scene 64 — parses the same inline NME JSON as Lite and
// attaches a MorphTargetManager with one target that offsets every vertex
// along +Y by SCENE64_MORPH_DELTA_Y. Weight is pinned to 1.0.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import "@babylonjs/core/Materials/Node/Blocks";
import { SCENE64_NME_JSON, SCENE64_MORPH_DELTA_Y, SCENE64_MORPH_PERIOD_MS } from "../shared/scene64-nme.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 5, new Vector3(0, 0, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 10000;

    const nm = NodeMaterial.Parse(SCENE64_NME_JSON, scene);
    nm.build(false);

    const sphere = MeshBuilder.CreateSphere("sphere", { segments: 32 }, scene);
    sphere.material = nm;

    // Build a matching morph target: absolute positions = base + (0, dY, 0) per vertex.
    const basePositions = sphere.getVerticesData(VertexBuffer.PositionKind)!;
    const abs = new Float32Array(basePositions.length);
    for (let i = 0; i < basePositions.length; i += 3) {
        abs[i] = basePositions[i]!;
        abs[i + 1] = basePositions[i + 1]! + SCENE64_MORPH_DELTA_Y;
        abs[i + 2] = basePositions[i + 2]!;
    }
    const mgr = new MorphTargetManager(scene);
    const freeze = new URLSearchParams(location.search).has("freeze");
    const target = new MorphTarget("m", freeze ? 1.0 : 0, scene);
    target.setPositions(abs);
    mgr.addTarget(target);
    sphere.morphTargetManager = mgr;

    const t0 = performance.now();
    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (!freeze) {
            const t = (performance.now() - t0) / SCENE64_MORPH_PERIOD_MS;
            target.influence = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
        }
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
