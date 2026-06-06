import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.7, 0.75, 0.82, 1.0);

    const cam = new ArcRotateCamera("cam", 0.4, 1.2, 20, new Vector3(-10, 0, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 10000;

    new HemisphericLight("light1", new Vector3(0, 1, 0), scene);

    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = 12;
    scene.fogEnd = 60;
    scene.fogColor = new Color3(0.7, 0.75, 0.82);

    const pbr = new PBRMetallicRoughnessMaterial("pbr", scene);
    pbr.baseColor = new Color3(1.0, 0.766, 0.336);
    pbr.metallic = 0;
    pbr.roughness = 1.0;

    for (let i = 0; i < 10; i++) {
        const box = MeshBuilder.CreateBox("box" + i, {}, scene);
        box.position = new Vector3(-i * 5, 0, 0);
        box.material = pbr;
    }

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
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
