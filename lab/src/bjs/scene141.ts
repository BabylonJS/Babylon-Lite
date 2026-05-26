// BJS reference for scene 141 — Scene 65 ESM shadows with NME, Standard, and PBR caster spheres.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { SCENE65_NME_JSON } from "../shared/scene65-nme.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2.3, Math.PI / 2.5, 8, new Vector3(0, 1, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 1000;

    const light = new DirectionalLight("dir", new Vector3(-1, -2, -1), scene);
    light.position = new Vector3(5, 10, 5);
    light.shadowMinZ = cam.minZ;
    light.shadowMaxZ = cam.maxZ;

    const nm = NodeMaterial.Parse(SCENE65_NME_JSON, scene);
    nm.build(false);

    const nmeSphere = MeshBuilder.CreateSphere("nmeSphere", { segments: 32 }, scene);
    nmeSphere.position = new Vector3(0, 1.5, 0);
    nmeSphere.material = nm;

    const stdSphere = MeshBuilder.CreateSphere("stdSphere", { segments: 32 }, scene);
    stdSphere.position = new Vector3(-2, 1.5, 0);
    const stdMaterial = new StandardMaterial("std", scene);
    stdMaterial.diffuseColor = new Color3(0.95, 0.28, 0.18);
    stdMaterial.specularPower = 32;
    stdSphere.material = stdMaterial;

    const pbrSphere = MeshBuilder.CreateSphere("pbrSphere", { segments: 32 }, scene);
    pbrSphere.position = new Vector3(2, 1.5, 0);
    const pbrMaterial = new PBRMaterial("pbr", scene);
    pbrMaterial.albedoColor = new Color3(0.15, 0.55, 1.0);
    pbrMaterial.metallic = 0.2;
    pbrMaterial.roughness = 0.45;
    pbrMaterial.usePhysicalLightFalloff = false;
    pbrSphere.material = pbrMaterial;

    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10, subdivisions: 2 }, scene);
    ground.material = nm;
    ground.receiveShadows = true;

    const sg = new ShadowGenerator(1024, light);
    sg.useBlurExponentialShadowMap = true;
    sg.useKernelBlur = true;
    sg.blurKernel = 64;
    sg.blurScale = 2;
    sg.depthScale = 50;
    sg.bias = 0.00005;
    sg.darkness = 0;
    sg.frustumEdgeFalloff = 0;
    sg.addShadowCaster(nmeSphere);
    sg.addShadowCaster(stdSphere);
    sg.addShadowCaster(pbrSphere);

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
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
