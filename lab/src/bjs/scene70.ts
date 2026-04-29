// BJS reference for Scene 70 — mirrors the Lite scene exactly. Same NME JSON,
// same 4-light + env setup, plus a non-zero AnisotropyBlock on a metallic gold sphere.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { SCENE70_NME_JSON } from "../shared/scene70-nme.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const envTex = CubeTexture.CreateFromPrefilteredData("https://assets.babylonjs.com/core/environments/environmentSpecular.env", scene);
    scene.environmentTexture = envTex;
    await new Promise<void>((resolve) => {
        if (envTex.isReady()) {
            resolve();
        } else {
            envTex.onLoadObservable.addOnce(() => resolve());
        }
    });

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 7, Vector3.Zero(), scene);
    cam.minZ = 0.1;
    cam.maxZ = 1000;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 1;
    const point = new PointLight("point", new Vector3(0, 5, -2), scene);
    point.intensity = 1;
    const spot = new SpotLight("spot", new Vector3(-0.5, 0, -2), new Vector3(0, 0, 1), Math.PI / 2, 1, scene);
    spot.intensity = 1;
    const dir = new DirectionalLight("dir", new Vector3(1, -1, 1), scene);
    dir.intensity = 10;

    const sphere = MeshBuilder.CreateSphere("sphere", { segments: 32, diameter: 2 }, scene);

    const nm = NodeMaterial.Parse(SCENE70_NME_JSON, scene);
    nm.build(false);
    sphere.material = nm;

    const eng = engine as any;
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
