// BJS reference for scene 72 — loads the same local EPY8BV#6 NME data and
// runs it through BJS NodeMaterial.Parse on a 4-light scene + sphere +
// ground with PCF directional shadow, mirroring playground D8AK3Z#160.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { getScene72Nme } from "../shared/scene72-nme.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.6, 0.8, 1, 1);

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

    cam.attachControl(canvas, true);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 1;
    const point = new PointLight("point", new Vector3(0, 5, -2), scene);
    point.intensity = 1;
    const spot = new SpotLight("spot", new Vector3(-0.5, 0, -2), new Vector3(0, 0, 1), Math.PI / 2, 1, scene);
    spot.intensity = 1;
    const dir = new DirectionalLight("dir", new Vector3(1, -1, 1), scene);
    dir.intensity = 10;
    dir.shadowMinZ = -2;
    dir.shadowMaxZ = 15;

    const sg = new ShadowGenerator(1024, dir);
    sg.usePercentageCloserFiltering = true;

    const sphere = MeshBuilder.CreateSphere("sphere", { segments: 32, diameter: 2 }, scene);
    const ground = MeshBuilder.CreateGround("ground", { width: 6, height: 6 }, scene);
    ground.position.y = -1;
    ground.receiveShadows = true;
    sg.addShadowCaster(sphere);

    const nm = NodeMaterial.Parse(await getScene72Nme(), scene);
    nm.build(false);
    sphere.material = nm;
    ground.material = nm;

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
