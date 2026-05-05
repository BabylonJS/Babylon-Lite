// BJS reference for scene 111. Mirrors the Lite stress scene except that point
// shadows stay disabled because Babylon Lite does not implement them yet.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { SCENE65_NME_JSON } from "../shared/scene65-nme.js";

function setIncluded(light: { includedOnlyMeshes: AbstractMesh[] }, meshes: readonly AbstractMesh[]): void {
    light.includedOnlyMeshes = [...meshes];
}

const STD_LIGHT_COUNT = 7;
const PBR_LIGHT_COUNT = 8;
const NME_LIGHT_COUNT = 8;
const RECEIVER_PLANE_SIZE = { width: 2.8, height: 4.8, subdivisions: 2 };

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.025, 0.03, 0.045, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 3, 12, new Vector3(0, 1.1, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 80;
    camera.attachControl(canvas, true);

    const stdSphere = MeshBuilder.CreateSphere("scene111-standard-sphere", { segments: 32, diameter: 1.7 }, scene);
    stdSphere.position = new Vector3(-3.2, 1.05, 0);
    stdSphere.receiveShadows = true;
    const stdMat = new StandardMaterial("std-mat", scene);
    stdMat.maxSimultaneousLights = STD_LIGHT_COUNT;
    stdMat.diffuseColor = new Color3(0.95, 0.18, 0.12);
    stdMat.specularColor = new Color3(0.55, 0.55, 0.55);
    stdMat.specularPower = 48;
    stdSphere.material = stdMat;

    const pbrSphere = MeshBuilder.CreateSphere("scene111-pbr-sphere", { segments: 32, diameter: 1.7 }, scene);
    pbrSphere.position = new Vector3(0, 1.05, 0);
    pbrSphere.receiveShadows = true;
    const pbrMat = new PBRMaterial("pbr-mat", scene);
    pbrMat.maxSimultaneousLights = PBR_LIGHT_COUNT;
    pbrMat.albedoColor = new Color3(0.15, 0.55, 1.0);
    pbrMat.metallic = 0.25;
    pbrMat.roughness = 0.35;
    pbrMat.environmentIntensity = 0;
    pbrSphere.material = pbrMat;

    const nmeSphere = MeshBuilder.CreateSphere("scene111-node-sphere", { segments: 32, diameter: 1.7 }, scene);
    nmeSphere.position = new Vector3(3.2, 1.05, 0);
    nmeSphere.receiveShadows = true;
    const nme = NodeMaterial.Parse(SCENE65_NME_JSON, scene);
    nme.maxSimultaneousLights = NME_LIGHT_COUNT;
    nme.build(false);
    nmeSphere.material = nme;

    const stdPlane = MeshBuilder.CreateGround("scene111-standard-plane", RECEIVER_PLANE_SIZE, scene);
    stdPlane.position = new Vector3(-3.2, 0, 0);
    stdPlane.receiveShadows = true;
    const stdPlaneMat = new StandardMaterial("std-plane-mat", scene);
    stdPlaneMat.maxSimultaneousLights = STD_LIGHT_COUNT;
    stdPlaneMat.diffuseColor = new Color3(0.34, 0.3, 0.28);
    stdPlaneMat.specularColor = new Color3(0.04, 0.04, 0.04);
    stdPlane.material = stdPlaneMat;

    const pbrPlane = MeshBuilder.CreateGround("scene111-pbr-plane", RECEIVER_PLANE_SIZE, scene);
    pbrPlane.position = new Vector3(0, 0, 0);
    pbrPlane.receiveShadows = true;
    const pbrPlaneMat = new StandardMaterial("pbr-plane-mat", scene);
    pbrPlaneMat.maxSimultaneousLights = PBR_LIGHT_COUNT;
    pbrPlaneMat.diffuseColor = new Color3(0.3, 0.32, 0.36);
    pbrPlaneMat.specularColor = new Color3(0.04, 0.04, 0.04);
    pbrPlane.material = pbrPlaneMat;

    const nmePlane = MeshBuilder.CreateGround("scene111-node-plane", RECEIVER_PLANE_SIZE, scene);
    nmePlane.position = new Vector3(3.2, 0, 0);
    nmePlane.receiveShadows = true;
    const nmePlaneMat = new StandardMaterial("nme-plane-mat", scene);
    nmePlaneMat.maxSimultaneousLights = NME_LIGHT_COUNT;
    nmePlaneMat.diffuseColor = new Color3(0.32, 0.28, 0.36);
    nmePlaneMat.specularColor = new Color3(0.04, 0.04, 0.04);
    nmePlane.material = nmePlaneMat;

    const light0 = new HemisphericLight("light0", new Vector3(0, 1, 0), scene);
    light0.intensity = 0.18;
    light0.diffuse = new Color3(0.5, 0.7, 1.0);
    light0.groundColor = new Color3(0.08, 0.06, 0.05);
    const light1 = new PointLight("light1", new Vector3(-4.5, 3.5, -3.4), scene);
    light1.intensity = 0.55;
    light1.diffuse = new Color3(1.0, 0.35, 0.25);
    light1.range = 12;
    const light2 = new SpotLight("light2", new Vector3(0, 4.5, -4.5), new Vector3(0, -1, 1).normalize(), Math.PI / 3, 2, scene);
    light2.intensity = 0.45;
    light2.diffuse = new Color3(0.45, 0.75, 1.0);
    light2.range = 14;

    const light3 = new DirectionalLight("light3", new Vector3(-0.6, -1, -0.25), scene);
    light3.position = new Vector3(3.5, 8, 5);
    light3.intensity = 0.65;
    light3.diffuse = new Color3(1.0, 0.85, 0.65);

    const light4 = new SpotLight("light4", new Vector3(-5, 5, 2.5), new Vector3(1, -1, -0.35).normalize(), Math.PI / 3.2, 3, scene);
    light4.intensity = 0.45;
    light4.diffuse = new Color3(0.6, 1.0, 0.7);
    light4.range = 13;
    const light5 = new HemisphericLight("light5", new Vector3(0.35, 1, 0.2), scene);
    light5.intensity = 0.16;
    light5.diffuse = new Color3(1.0, 0.75, 0.5);
    light5.groundColor = new Color3(0.04, 0.06, 0.09);
    const light6 = new DirectionalLight("light6", new Vector3(0.7, -1, 0.2), scene);
    light6.intensity = 0.22;
    light6.diffuse = new Color3(0.8, 0.85, 1.0);
    const light7 = new PointLight("light7", new Vector3(3.5, 3, 4.8), scene);
    light7.intensity = 0.42;
    light7.diffuse = new Color3(1.0, 0.4, 0.85);
    light7.range = 10;

    const light8 = new SpotLight("light8", new Vector3(4.8, 6.0, -4.8), new Vector3(-3.2, -4.95, 4.8).normalize(), 1.25, 2, scene);
    light8.intensity = 0.75;
    light8.diffuse = new Color3(0.65, 0.9, 1.0);
    light8.range = 16;

    const light9 = new PointLight("light9", new Vector3(-2, 3.8, 4.2), scene);
    light9.intensity = 0.45;
    light9.diffuse = new Color3(1.0, 0.9, 0.45);
    light9.range = 10;
    const light10 = new DirectionalLight("light10", new Vector3(-0.25, -1, 0.8), scene);
    light10.intensity = 0.25;
    light10.diffuse = new Color3(0.55, 1.0, 0.85);
    const light11 = new SpotLight("light11", new Vector3(5.3, 5, -2), new Vector3(-1, -1, 0.15).normalize(), Math.PI / 3.4, 2, scene);
    light11.intensity = 0.42;
    light11.diffuse = new Color3(0.9, 0.55, 1.0);
    light11.range = 12;
    const light12 = new PointLight("light12", new Vector3(0, 3.1, 0.3), scene);
    light12.intensity = 0.38;
    light12.diffuse = new Color3(0.75, 1.0, 0.65);
    light12.range = 8;

    const light13 = new DirectionalLight("light13", new Vector3(0.85, -1, -0.55), scene);
    light13.position = new Vector3(6, 8, 5);
    light13.intensity = 0.58;
    light13.diffuse = new Color3(0.9, 0.8, 1.0);

    const light14 = new SpotLight("light14", new Vector3(-4.2, 3.6, 4.4), new Vector3(1, -0.45, -1).normalize(), Math.PI / 3, 2, scene);
    light14.intensity = 0.35;
    light14.diffuse = new Color3(0.4, 0.85, 1.0);
    light14.range = 12;
    const light15 = new DirectionalLight("light15", new Vector3(0, -1, -0.7), scene);
    light15.intensity = 0.2;
    light15.diffuse = new Color3(1.0, 0.65, 0.45);

    const stdSet = [stdSphere, stdPlane];
    const pbrSet = [pbrSphere, pbrPlane];
    const nmeSet = [nmeSphere, nmePlane];
    setIncluded(light0, [...stdSet, ...nmeSet]);
    setIncluded(light1, [...stdSet, ...pbrSet]);
    setIncluded(light2, pbrSet);
    setIncluded(light3, [...stdSet, ...pbrSet]);
    setIncluded(light4, stdSet);
    setIncluded(light5, [...pbrSet, ...nmeSet]);
    setIncluded(light6, stdSet);
    setIncluded(light7, nmeSet);
    setIncluded(light8, [...pbrSet, ...nmeSet]);
    setIncluded(light9, stdSet);
    setIncluded(light10, pbrSet);
    setIncluded(light11, nmeSet);
    setIncluded(light12, [...pbrSet, ...nmeSet]);
    setIncluded(light13, [...stdSet, ...nmeSet]);
    setIncluded(light14, pbrSet);
    setIncluded(light15, nmeSet);

    const shadow3 = new ShadowGenerator(512, light3);
    shadow3.useBlurExponentialShadowMap = true;
    shadow3.useKernelBlur = true;
    shadow3.blurScale = 2;
    shadow3.depthScale = 40;
    shadow3.bias = 0.00008;
    shadow3.darkness = 0.15;
    [stdSphere, pbrSphere].forEach((m) => shadow3.addShadowCaster(m));

    const shadow8 = new ShadowGenerator(512, light8);
    shadow8.usePercentageCloserFiltering = true;
    shadow8.darkness = 0.1;
    [pbrSphere, nmeSphere].forEach((m) => shadow8.addShadowCaster(m));

    const shadow13 = new ShadowGenerator(512, light13);
    shadow13.usePercentageCloserFiltering = true;
    shadow13.darkness = 0.12;
    [stdSphere, nmeSphere].forEach((m) => shadow13.addShadowCaster(m));

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame?.();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
