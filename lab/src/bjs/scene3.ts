import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
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
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const cam = new ArcRotateCamera("cam", 0.4, 1.2, 20, new Vector3(-10, 0, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 10000;

    new PointLight("point", new Vector3(10, 50, 50), scene);

    scene.fogMode = Scene.FOGMODE_EXP;
    scene.fogDensity = 0.02;
    scene.fogColor = new Color3(0.9, 0.9, 0.85);

    for (let i = 0; i < 10; i++) {
        const box = MeshBuilder.CreateBox("box" + i, {}, scene);
        box.position = new Vector3(-i * 5, 0, 0);
        const mat = new StandardMaterial("mat" + i, scene);
        mat.diffuseColor = new Color3(1, 1, 0);
        box.material = mat;
    }

    const skybox = MeshBuilder.CreateBox("skyBox", { size: 100 }, scene);
    const skyboxMat = new StandardMaterial("skyBoxMat", scene);
    skyboxMat.backFaceCulling = false;
    skyboxMat.reflectionTexture = new CubeTexture("https://playground.babylonjs.com/textures/skybox", scene);
    skyboxMat.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
    skyboxMat.diffuseColor = new Color3(0, 0, 0);
    skyboxMat.specularColor = new Color3(0, 0, 0);
    skyboxMat.disableLighting = true;
    skybox.material = skyboxMat;

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
    // Wait several frames to ensure skybox cube faces are fully uploaded
    for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    }
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
