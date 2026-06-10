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

    const camera = createArcRotateCamera(0, Math.PI / 2.2, 0.01, { x: 5.0855, y: 2.492, z: 0.1654 });
    camera.nearPlane = 0.1;
    camera.farPlane = 10000;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    // Final chromatic-aberration pass writes directly into the engine swapchain (a
    // fullscreen blit, so single-sample is pixel-identical to MSAA-resolve-to-swap).
    const outputTarget = engine.scRT;

    const sourceTarget = createRenderTarget({
        lbl: "scene143-source",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: "canvas",
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
            sourceSamplingMode: "linear",
            direction: { x: 1, y: 0 },
            kernel: 16,
        },
        engine,
        scene
    );
    const blurY = createBlurPostProcessTask(
        {
            name: "scene143-blur-y",
            sourceTexture: blurX.outputTexture,
            sourceSamplingMode: "linear",
            direction: { x: 0, y: 1 },
            kernel: 16,
        },
        engine,
        scene
    );
    const chromatic = createChromaticAberrationPostProcessTask(
        {
            name: "scene143-chromatic-aberration",
            sourceTexture: blurY.outputTexture,
            targetTexture: outputTarget,
            sourceSamplingMode: "linear",
            aberrationAmount: 45,
            radialIntensity: 0,
            direction: { x: 0.707, y: -0.707 },
            centerPosition: { x: 0.5, y: 0.5 },
        },
        engine,
        scene
    );
    addTask(scene, blurX);
    addTask(scene, blurY);
    addTask(scene, chromatic);

    await registerScene(engine, scene);
    blurX.updateUniforms();
    blurY.updateUniforms();
    chromatic.updateUniforms();
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
