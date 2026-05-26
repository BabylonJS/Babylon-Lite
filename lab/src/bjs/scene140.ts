// BJS reference for scene 140 — Scene 66 variant with final-alpha discard on
// the NME shadow casters.

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
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import { TransformBlock } from "@babylonjs/core/Materials/Node/Blocks/transformBlock";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapFragment";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapFragmentExtraDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapFragmentSoftTransparentShadow";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexExtraDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexMetric";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexNormalBias";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import "@babylonjs/core/Materials/Node/Blocks";
import { SCENE66_MORPH_PERIOD_MS, createScene66FinalAlphaDiscardJson, getScene66Nme, sphereScrambleDeltas } from "../shared/scene66-nme.js";

function attachShadowDepthWrapper(material: NodeMaterial, scene: Scene): void {
    const worldPosBlock = material.getBlockByName("worldPos");
    if (!(worldPosBlock instanceof TransformBlock)) {
        throw new Error("Scene 140 caster NodeMaterial is missing its worldPos TransformBlock");
    }

    material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene, {
        remappedVariables: ["worldPos", worldPosBlock.output.associatedVariableName, "alpha", "1."],
    });
}

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

    const params = new URLSearchParams(location.search);
    const shadowHoleProbe = params.has("shadowHoleProbe");
    const noShadows = params.has("noShadows");
    const solidShadowCaster = params.has("solidShadowCaster");
    const morphStep = params.has("morphStep");
    const manualMorph = params.has("manualMorph");

    const light = new DirectionalLight("light", new Vector3(1, -1, 1), scene);
    light.intensity = 0.7;
    light.shadowMinZ = -10;
    light.shadowMaxZ = 10;

    const sg = noShadows ? null : new ShadowGenerator(1024, light);
    if (sg) {
        sg.usePercentageCloserFiltering = true;
        sg.transparencyShadow = true;
    }

    const sphere = Mesh.CreateSphere("sphere", 16, 2, scene, true);
    sphere.position.y = 1;
    sphere.position.x = -1.2;

    const box = MeshBuilder.CreateBox("box", { size: shadowHoleProbe ? 2 : 1 }, scene);
    box.position.y = shadowHoleProbe ? 1.4 : 1;
    box.position.x = shadowHoleProbe ? 0 : 1.2;

    const ground = MeshBuilder.CreateGround("ground", { width: 6, height: 6 }, scene);
    ground.receiveShadows = !noShadows;

    if (sg) {
        if (!shadowHoleProbe) {
            sg.addShadowCaster(sphere);
        }
        sg.addShadowCaster(box);
    }

    const { json } = await getScene66Nme();
    const casterJson = createScene66FinalAlphaDiscardJson(json);
    const receiverMaterial = NodeMaterial.Parse(json, scene);
    receiverMaterial.build(false);
    const casterMaterial = NodeMaterial.Parse(casterJson, scene);
    casterMaterial.build(false);
    attachShadowDepthWrapper(casterMaterial, scene);
    sphere.material = casterMaterial;
    box.material = shadowHoleProbe && solidShadowCaster ? new StandardMaterial("solidShadowCaster", scene) : casterMaterial;
    ground.material = receiverMaterial;

    const basePositions = sphere.getVerticesData(VertexBuffer.PositionKind)!;
    const vertexCount = basePositions.length / 3;
    const deltas = sphereScrambleDeltas(vertexCount);
    const abs = new Float32Array(basePositions.length);
    for (let i = 0; i < basePositions.length; i++) {
        abs[i] = basePositions[i]! + deltas[i]!;
    }
    const mgr = new MorphTargetManager(scene);
    const freeze = params.has("freeze");
    const target = new MorphTarget("scramble", freeze ? 1 : 0, scene);
    target.setPositions(abs);
    mgr.addTarget(target);
    sphere.morphTargetManager = mgr;

    if (shadowHoleProbe) {
        sphere.dispose();
    }

    let t0 = 0;
    const eng = engine as any;
    if (manualMorph) {
        (globalThis as { __scene140SetMorphWeight?: (value: number) => void }).__scene140SetMorphWeight = (value: number) => {
            target.influence = value;
        };
        target.influence = 0;
    }
    scene.onBeforeRenderObservable.add(() => {
        if (!freeze && !manualMorph) {
            if (morphStep) {
                if (canvas.dataset.ready === "true") {
                    if (t0 === 0) {
                        t0 = performance.now();
                    }
                    target.influence = performance.now() - t0 >= 700 ? 1 : 0;
                } else {
                    target.influence = 0;
                }
            } else {
                if (t0 === 0) {
                    t0 = performance.now();
                }
                const t = (performance.now() - t0) / SCENE66_MORPH_PERIOD_MS;
                const s = Math.sin(t * Math.PI * 2);
                target.influence = s * s;
            }
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
