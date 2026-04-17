import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
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

    const camera = new FreeCamera("Camera", new Vector3(0, 10, -20), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(canvas, true);

    // Ground
    const ground01 = MeshBuilder.CreateGround("Spotlight Hard Shadows", { width: 24, height: 60 }, scene);

    const groundMaterial = new StandardMaterial("ground", scene);
    groundMaterial.diffuseTexture = new Texture("https://playground.babylonjs.com/textures/ground.jpg", scene);
    groundMaterial.specularColor = new Color3(0, 0, 0);
    groundMaterial.emissiveColor = new Color3(0.2, 0.2, 0.2);
    ground01.material = groundMaterial;
    ground01.receiveShadows = true;

    // Box
    const box00 = MeshBuilder.CreateBox("*box00", { size: 5 }, scene);
    box00.position = new Vector3(0, 5, 0);

    const boxMaterial = new StandardMaterial("mat", scene);
    boxMaterial.diffuseColor = new Color3(1.0, 0, 0);
    boxMaterial.specularColor = new Color3(0.5, 0, 0);
    box00.material = boxMaterial;

    // Shadows
    const light00 = new SpotLight("*spot00", new Vector3(0, 20, -10), new Vector3(0, -1, 0.3), 1.2, 24, scene);

    const shadowGenerator00 = new ShadowGenerator(512, light00);
    shadowGenerator00.getShadowMap()!.renderList!.push(box00);
    shadowGenerator00.usePercentageCloserFiltering = true;

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
