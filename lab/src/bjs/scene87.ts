// BJS reference for scene 87 — shared NME graph covering IridescenceBlock plus
// ImageProcessingBlock on an environment-lit PBR sphere.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { SCENE87_NME_JSON } from "../shared/scene87-nme.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.015, 0.015, 0.025, 1);
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.85;
    scene.imageProcessingConfiguration.contrast = 1.15;

    const envTex = CubeTexture.CreateFromPrefilteredData("https://assets.babylonjs.com/core/environments/environmentSpecular.env", scene);
    scene.environmentTexture = envTex;
    await new Promise<void>((resolve) => {
        if (envTex.isReady()) {
            resolve();
        } else {
            envTex.onLoadObservable.addOnce(() => resolve());
        }
    });

    const cam = new ArcRotateCamera("cam", -Math.PI / 2.15, Math.PI / 2.15, 6.2, Vector3.Zero(), scene);
    cam.minZ = 0.1;
    cam.maxZ = 1000;
    cam.attachControl(canvas, true);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.55;
    const dir = new DirectionalLight("dir", new Vector3(0.45, -0.65, 0.35), scene);
    dir.intensity = 2.8;

    const sphere = MeshBuilder.CreateSphere("iridescentSphere", { segments: 64, diameter: 2.4 }, scene);
    const nm = NodeMaterial.Parse(SCENE87_NME_JSON, scene);
    nm.build(false);
    sphere.material = nm;

    const eng = engine as unknown as { _drawCalls?: { current: number } };
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
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
