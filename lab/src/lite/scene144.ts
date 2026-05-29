import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createBloomPostProcessTask,
    createDefaultCamera,
    createEngine,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    goToFrame,
    loadEnvironment,
    loadGltf,
    pauseAnimation,
    playAnimation,
    registerScene,
    startEngine,
    stopAnimation,
} from "babylon-lite";

const DRAGON_URL = "https://assets.babylonjs.com/meshes/tarisland_dragon/tarisland_dragon_high_poly.glb";
const ENV_URL = "https://playground.babylonjs.com/textures/environment.env";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    addToScene(scene, await loadGltf(engine, DRAGON_URL));
    await loadEnvironment(scene, ENV_URL, {
        brdfUrl: "/brdf-lut.png",
        skipGround: true,
        skipSkybox: true,
    });
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;

    for (const group of scene.animationGroups) {
        stopAnimation(group);
    }
    const anim = scene.animationGroups.find((group) => group.name === "Qishilong_attack01")!;
    playAnimation(anim);
    goToFrame(anim, 180, engine);
    pauseAnimation(anim);

    const camera = createDefaultCamera(scene);
    camera.alpha = Math.PI / 2;
    camera.radius = 76;
    camera.target.x = -0.2622444548385374;
    camera.target.y = 16.769186617371343;
    camera.target.z = -15.684827697408707;
    attachControl(camera, canvas, scene);

    const sourceTarget = createRenderTarget({
        label: "scene144-source",
        colorFormat: engine.format,
        depthStencilFormat: "depth24plus-stencil8",
        sampleCount: 1,
        size: "canvas",
    });
    const sourceTask = createRenderTask(
        {
            name: "scene144-source",
            rt: sourceTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );

    const outputTarget = createRenderTarget({
        label: "scene144-bloom-output",
        colorFormat: engine.format,
        sampleCount: engine.msaaSamples,
        size: "canvas",
        resolveToSwapchain: true,
    });
    const bloom = createBloomPostProcessTask(
        {
            name: "scene144-bloom",
            sourceTexture: sourceTarget,
            targetTexture: outputTarget,
            sourceSamplingMode: "linear",
            threshold: 0.1,
            weight: 2,
            kernel: 64,
        },
        engine,
        scene
    );

    addTaskAtStart(scene, sourceTask);
    addTask(scene, bloom);

    await registerScene(engine, scene);
    bloom.updateUniforms();
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
