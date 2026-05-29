import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { PostProcessRenderPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipeline";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import { BloomEffect } from "@babylonjs/core/PostProcesses/bloomEffect";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const DRAGON_ROOT = "https://assets.babylonjs.com/meshes/tarisland_dragon/";
const DRAGON_FILE = "tarisland_dragon_high_poly.glb";
const ENV_URL = "https://playground.babylonjs.com/textures/environment.env";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);

    await SceneLoader.AppendAsync(DRAGON_ROOT, DRAGON_FILE, scene);
    scene.cameras[0]?.dispose();
    scene.stopAllAnimations();

    const anim = scene.getAnimationGroupByName("Qishilong_attack01")!;
    anim.play();
    anim.goToFrame(180);
    anim.pause();

    scene.createDefaultCamera(true, true, true);
    const camera = scene.activeCamera as ArcRotateCamera;
    camera.alpha += Math.PI;
    camera.radius = 76;

    const pipeline = new PostProcessRenderPipeline(engine, "scene144-bloom-pipeline");
    const bloom = new BloomEffect(scene, 0.5, 2, 64);
    bloom.threshold = 0.1;
    pipeline.addEffect(bloom);
    scene.postProcessRenderPipelineManager.addPipeline(pipeline);
    scene.postProcessRenderPipelineManager.attachCamerasToRenderPipeline("scene144-bloom-pipeline", camera);

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
