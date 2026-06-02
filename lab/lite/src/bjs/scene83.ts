// BJS reference for scene 83 — parses the same NME normals/AO JSON as Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { SCENE83_NME_JSON } from "../shared/scene83-nme.js";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 4, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const light = new DirectionalLight("key", new Vector3(0, 0, 1), scene);
    light.intensity = 3.25;

    const material = NodeMaterial.Parse(SCENE83_NME_JSON, scene);
    const aoDepth = RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 128, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    aoDepth.wrapU = Texture.WRAP_ADDRESSMODE;
    aoDepth.wrapV = Texture.WRAP_ADDRESSMODE;
    const positionTex = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 128, 255, 255, 0, 128, 255, 0, 255, 128, 255, 255, 255, 128, 255]), 2, 2, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    positionTex.wrapU = Texture.CLAMP_ADDRESSMODE;
    positionTex.wrapV = Texture.CLAMP_ADDRESSMODE;
    const aoSource = material.getBlockByName("AoDepth") as { texture: RawTexture | null } | null;
    if (aoSource) {
        aoSource.texture = aoDepth;
    }
    const positionSample = material.getBlockByName("PositionSample") as { fragmentOnly: boolean; texture: RawTexture | null } | null;
    if (positionSample) {
        positionSample.fragmentOnly = false;
        positionSample.texture = positionTex;
    }
    const aoBlock = material.getBlockByName("AmbientOcclusion") as { radius: number; area: number; fallOff: number } | null;
    if (aoBlock) {
        aoBlock.radius = 0.0001;
        aoBlock.area = 0.1;
        aoBlock.fallOff = -0.1;
    }
    material.build(false);

    const plane = MeshBuilder.CreatePlane("plane", { width: 3.2, height: 2.2 }, scene);
    plane.material = material;

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => {
        engineWithDrawCalls._drawCalls?.fetchNewFrame?.();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
