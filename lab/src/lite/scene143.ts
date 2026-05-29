import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBlurPostProcessTask,
    createChromaticAberrationPostProcessTask,
    createEngine,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    loadBabylon,
    registerScene,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    addToScene(scene, await loadBabylon(engine, "https://www.babylonjs.com/Scenes/Sponza/Sponza.babylon", { loadCamera: false }));

    scene.camera = createArcRotateCamera(0, Math.PI / 2.2, 0.01, { x: 5.0855, y: 2.492, z: 0.1654 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera, canvas, scene);

    const outputTarget = createRenderTarget({
        label: "scene143-postprocess-output",
        colorFormat: engine.format,
        sampleCount: engine.msaaSamples,
        size: "canvas",
        resolveToSwapchain: true,
    });

    const sourceTarget = createRenderTarget({
        label: "scene143-source",
        colorFormat: engine.format,
        depthStencilFormat: "depth24plus-stencil8",
        sampleCount: 1,
        size: "canvas",
        flipY: false,
    });
    const sourceTask = createRenderTask(
        {
            name: "scene143-source",
            rt: sourceTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );

    addTaskAtStart(scene, sourceTask);
    const blurX = createBlurPostProcessTask(
        {
            name: "scene143-blur-x",
            sourceTexture: sourceTarget,
            targetTexture: outputTarget,
            sourceSamplingMode: "linear",
            direction: { x: 1, y: 0 },
            kernel: 16,
        },
        engine,
        scene
    );
    // const blurY = createBlurPostProcessTask(
    //     {
    //         name: "scene143-blur-y",
    //         sourceTexture: blurX.outputTexture,
    //         sourceSamplingMode: "linear",
    //         direction: { x: 0, y: 1 },
    //         kernel: 16,
    //     },
    //     engine,
    //     scene
    // );
    // const chromatic = createChromaticAberrationPostProcessTask(
    //     {
    //         name: "scene143-chromatic-aberration",
    //         sourceTexture: blurY.outputTexture,
    //         targetTexture: outputTarget,
    //         sourceSamplingMode: "linear",
    //         aberrationAmount: 45,
    //         radialIntensity: 0,
    //         direction: { x: 0.707, y: 0.707 },
    //     },
    //     engine,
    //     scene
    // );
    addTask(scene, blurX);
    // addTask(scene, blurY);
    // addTask(scene, chromatic);

    await registerScene(engine, scene);
    blurX.updateUniforms();
    // blurY.updateUniforms();
    // chromatic.updateUniforms();
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
