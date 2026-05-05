// BJS reference for scene 81 — parses the same NME UV/projection JSON as Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { SCENE81_NME_JSON, SCENE81_TEXTURE_URL } from "../shared/scene81-nme.js";

type TextureOwnerBlock = {
    texture: Texture;
};

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI * 0.42, Math.PI * 0.42, 4.2, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.25;
    camera.maxZ = 100;

    const material = NodeMaterial.Parse(SCENE81_NME_JSON, scene);
    const atlas = new Texture(SCENE81_TEXTURE_URL, scene, true, true, Texture.NEAREST_SAMPLINGMODE);
    (material.getBlockByName("AtlasUV") as TextureOwnerBlock).texture = atlas;
    (material.getBlockByName("TriAtlas") as TextureOwnerBlock).texture = atlas;
    (material.getBlockByName("BiAtlas") as TextureOwnerBlock).texture = atlas;
    material.build(false);

    const sphere = MeshBuilder.CreateSphere("sphere", { segments: 48, diameter: 2.6 }, scene);
    sphere.material = material;

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
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
