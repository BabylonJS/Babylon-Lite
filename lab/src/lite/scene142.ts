import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createAnaglyphPostProcessTask,
    createArcRotateCamera,
    createBlackAndWhitePostProcessTask,
    createBlurPostProcessTask,
    createBox,
    createChromaticAberrationPostProcessTask,
    createEngine,
    createHemisphericLight,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "babylon-lite";

function bjsEulerToQuaternion(rx: number, ry: number, rz: number): [number, number, number, number] {
    const halfRoll = rz * 0.5;
    const halfPitch = rx * 0.5;
    const halfYaw = ry * 0.5;
    const sinRoll = Math.sin(halfRoll);
    const cosRoll = Math.cos(halfRoll);
    const sinPitch = Math.sin(halfPitch);
    const cosPitch = Math.cos(halfPitch);
    const sinYaw = Math.sin(halfYaw);
    const cosYaw = Math.cos(halfYaw);
    return [
        cosYaw * sinPitch * cosRoll + sinYaw * cosPitch * sinRoll,
        sinYaw * cosPitch * cosRoll - cosYaw * sinPitch * sinRoll,
        cosYaw * cosPitch * sinRoll - sinYaw * sinPitch * cosRoll,
        cosYaw * cosPitch * cosRoll + sinYaw * sinPitch * sinRoll,
    ];
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.12, g: 0.23, b: 0.42, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.45, 2.2, { x: 0, y: 0.25, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 100;
    attachControl(scene.camera, canvas, scene);
    const leftCamera = createArcRotateCamera(-Math.PI / 2 - 0.035, Math.PI / 2.45, 2.2, { x: 0, y: 0.25, z: 0 });
    leftCamera.nearPlane = 0.1;
    leftCamera.farPlane = 100;
    attachControl(leftCamera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.4));

    const sourceTarget = createRenderTarget({
        label: "scene142-source",
        colorFormat: engine.format,
        depthStencilFormat: "depth24plus-stencil8",
        sampleCount: 1,
        size: "canvas",
    });
    const sourceTask = createRenderTask(
        {
            name: "scene142-source",
            rt: sourceTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );
    const leftTarget = createRenderTarget({
        label: "scene142-left",
        colorFormat: engine.format,
        depthStencilFormat: "depth24plus-stencil8",
        sampleCount: 1,
        size: "canvas",
    });
    const leftTask = createRenderTask(
        {
            name: "scene142-left",
            rt: leftTarget,
            clrColor: scene.clearColor,
            clr: true,
            cam: leftCamera,
        },
        engine,
        scene
    );

    const colors: readonly (readonly [number, number, number])[] = [
        [1, 0.12, 0.05],
        [0.05, 0.85, 0.16],
        [0.15, 0.32, 1],
    ];
    const positions = [-1.55, 0, 1.55];
    for (let i = 0; i < 3; i++) {
        const box = createBox(engine, 1.15);
        box.position.set(positions[i]!, 0, 0);
        box.rotationQuaternion.set(...bjsEulerToQuaternion(-0.25, 0.55, 0));
        const material = createStandardMaterial();
        material.diffuseColor = colors[i]!;
        material.specularColor = [0, 0, 0];
        box.material = material;
        addToScene(scene, box);
        sourceTask.addMesh(box);
        leftTask.addMesh(box);
    }

    const outputTarget = createRenderTarget({
        label: "scene142-postprocess-output",
        colorFormat: engine.format,
        sampleCount: engine.msaaSamples,
        size: "canvas",
        resolveToSwapchain: true,
    });
    const blackAndWhite = createBlackAndWhitePostProcessTask(
        {
            name: "scene142-black-and-white",
            sourceTexture: sourceTarget,
            targetTexture: outputTarget,
            sourceSamplingMode: "linear",
            degree: 0,
            viewport: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
        },
        engine,
        scene
    );
    const anaglyph = createAnaglyphPostProcessTask(
        {
            name: "scene142-anaglyph",
            sourceTexture: sourceTarget,
            leftTexture: leftTarget,
            targetTexture: outputTarget,
            sourceSamplingMode: "linear",
            viewport: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            clear: false,
        },
        engine,
        scene
    );
    const blur = createBlurPostProcessTask(
        {
            name: "scene142-blur",
            sourceTexture: sourceTarget,
            targetTexture: outputTarget,
            sourceSamplingMode: "linear",
            direction: { x: 1, y: 1 },
            kernel: 128,
            viewport: { x: 0, y: 0, width: 0.5, height: 0.5 },
            clear: false,
        },
        engine,
        scene
    );
    const chromatic = createChromaticAberrationPostProcessTask(
        {
            name: "scene142-chromatic-aberration",
            sourceTexture: sourceTarget,
            targetTexture: outputTarget,
            sourceSamplingMode: "linear",
            aberrationAmount: 70,
            radialIntensity: 0,
            direction: { x: 0.707, y: 0.707 },
            viewport: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
            clear: false,
        },
        engine,
        scene
    );
    addTaskAtStart(scene, leftTask);
    addTaskAtStart(scene, sourceTask);
    addTask(scene, blackAndWhite);
    addTask(scene, anaglyph);
    addTask(scene, blur);
    addTask(scene, chromatic);

    await registerScene(engine, scene);
    blackAndWhite.degree = 1;
    blackAndWhite.updateUniforms();
    blur.updateUniforms();
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
