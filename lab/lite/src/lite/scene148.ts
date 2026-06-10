// Scene 148 — Depth of Field post-process showcase.
//
// Port of https://playground.babylonjs.com/#SUEU9U#120: the Babylon.js
// PowerPlant model (converted to glb) is rendered through the frame-graph
// GeometryRendererTask to produce a camera-space view-depth texture, which
// feeds the new DepthOfField post-process (circle-of-confusion → CoC-weighted
// blur pyramid → merge). With a near focus distance and a wide aperture the
// foreground stays sharp while the rest of the plant falls progressively out of
// focus. Camera and lens parameters match the playground.

import {
    addTask,
    addToScene,
    attachControl,
    createDefaultCamera,
    createDepthOfFieldPostProcessTask,
    createEngine,
    createGeometryRendererTask,
    createHemisphericLight,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    DepthOfFieldBlurLevel,
    GeometryTextureType,
    loadGltf,
    registerScene,
    startEngine,
} from "babylon-lite";

const POWERPLANT_URL = "https://assets.babylonjs.com/meshes/PowerPlant/powerplant.glb";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    addToScene(scene, await loadGltf(engine, POWERPLANT_URL));

    // Match BJS createDefaultCameraOrLight(replace=true): it disposes every existing
    // light (the glb ships one directional light via KHR_lights_punctual) and adds a
    // single default HemisphericLight(Up). The playground then bumps it to intensity 2.
    scene.lights.length = 0;
    addToScene(scene, createHemisphericLight([0, 1, 0], 2));

    // Auto-frame the camera to the model bounds (matches BJS createDefaultCameraOrLight),
    // then apply the playground's orbit angles. minZ/maxZ stay at the auto values.
    const camera = createDefaultCamera(scene);
    camera.alpha = -2.646;
    camera.beta = 1.313;
    camera.radius = 109.071;
    attachControl(camera, canvas, scene);

    const sampleCount = 4;

    // Offscreen colour target — the scene renders here at MSAA sampleCount.
    const colorTarget = createRenderTarget({
        lbl: "scene148-color",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: sampleCount,
        size: "canvas",
    });
    // Single-sample resolve of colorTarget — the depth-of-field source. The
    // render task resolves the MSAA colour into this at end-of-pass (the CoC /
    // blur post-processes require a single-sample source).
    const colorResolveTarget = createRenderTarget({
        lbl: "scene148-color-resolve",
        format: engine.format,
        samples: 1,
        size: "canvas",
    });
    const scRT = engine.scRT;

    // Geometry renderer → camera-space view depth (r16float). Rendered at
    // samples=1 (single-sample): MSAA depth has to be resolved by averaging,
    // which produces meaningless intermediate depths at silhouettes, so we keep
    // the depth single-sample even though the colour render is MSAA. VIEW_DEPTH
    // normally clears to the camera far plane, but BJS's PREPASS_DEPTH clears the
    // background to 0 (→ CoC = 1, fully out of focus); override the clear to 0.
    const geomTask = createGeometryRendererTask(
        {
            name: "scene148-geom",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.VIEW_DEPTH, format: "r16float", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        },
        engine,
        scene
    );

    const sceneTask = createRenderTask(
        {
            name: "scene148-scene",
            rt: colorTarget,
            rst: colorResolveTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );

    const dofTask = createDepthOfFieldPostProcessTask(
        {
            name: "scene148-dof",
            sourceTexture: colorResolveTarget,
            depthTexture: geomTask.geometryViewDepthTexture!,
            camera,
            blurLevel: DepthOfFieldBlurLevel.High,
            depthNotNormalized: true,
            lensSize: 50,
            focalLength: 50,
            fStop: 0.04,
            focusDistance: 80000,
            targetTexture: scRT,
        },
        engine,
        scene
    );

    addTask(scene, geomTask);
    addTask(scene, sceneTask);
    addTask(scene, dofTask);

    await registerScene(engine, scene);
    dofTask.updateUniforms();
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
