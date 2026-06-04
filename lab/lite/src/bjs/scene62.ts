// BJS reference for scene 62 — parses the same inline NME JSON as Lite and
// attaches the same crate texture to the TextureBlock.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { TextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/textureBlock";
import "@babylonjs/core/Materials/Node/Blocks";
import { SCENE62_NME_JSON, SCENE62_TEXTURE_URL } from "../shared/scene62-nme.js";

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

    const nm = NodeMaterial.Parse(SCENE62_NME_JSON, scene);
    const texBlock = nm.getBlockByName("diffuse") as TextureBlock;
    texBlock.texture = new Texture(SCENE62_TEXTURE_URL, scene);
    nm.build(false);

    const sphere = MeshBuilder.CreateSphere("sphere", { segments: 32 }, scene);
    sphere.material = nm;

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
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
