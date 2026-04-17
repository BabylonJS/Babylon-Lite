import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import { PBRSpecularGlossinessMaterial } from "@babylonjs/core/Materials/PBR/pbrSpecularGlossinessMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    const camera = new ArcRotateCamera("camera1", 0, Math.PI / 2, 5, Vector3.Zero(), scene);
    camera.lowerRadiusLimit = 2;
    camera.upperRadiusLimit = 10;
    camera.attachControl(canvas, true);

    const sphere = Mesh.CreateSphere("sphere1", 16, 2, scene);

    const pbr = new PBRSpecularGlossinessMaterial("pbr", scene);
    sphere.material = pbr;
    pbr.diffuseColor = new Color3(1.0, 0.766, 0.336);
    pbr.specularColor = new Color3(1.0, 0.766, 0.336);
    pbr.glossiness = 0.4;
    pbr.environmentTexture = CubeTexture.CreateFromPrefilteredData("https://assets.babylonjs.com/core/environments/environmentSpecular.env", scene);

    scene.createDefaultEnvironment({ createSkybox: true, createGround: true, skyboxSize: 1000 });

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
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
