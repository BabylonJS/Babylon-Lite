import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { BlurPostProcess } from "@babylonjs/core/PostProcesses/blurPostProcess";
import { ChromaticAberrationPostProcess } from "@babylonjs/core/PostProcesses/chromaticAberrationPostProcess";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Loading/loadingScreen";
import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import "@babylonjs/loaders";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    await SceneLoader.AppendAsync("https://www.babylonjs.com/Scenes/Sponza/", "Sponza.babylon", scene);

    const camera = new ArcRotateCamera("camera", 0, Math.PI / 2.2, 0.01, new Vector3(5.0855, 2.492, 0.1654), scene);
    camera.minZ = 0.1;
    camera.maxZ = 10000;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    new BlurPostProcess("scene143-blur-x", new Vector2(1, 0), 16, 1, camera, Texture.BILINEAR_SAMPLINGMODE, engine);
    // new BlurPostProcess("scene143-blur-y", new Vector2(0, 1), 16, 1, camera, Texture.BILINEAR_SAMPLINGMODE, engine);
    // const chromatic = new ChromaticAberrationPostProcess("scene143-chromatic-aberration", engine.getRenderWidth(), engine.getRenderHeight(), 1, camera, Texture.BILINEAR_SAMPLINGMODE, engine);
    // chromatic.aberrationAmount = 45;
    // chromatic.radialIntensity = 0;
    // chromatic.direction = new Vector2(0.707, 0.707);
    // chromatic.centerPosition = new Vector2(0.5, 0.5);

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    }
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
