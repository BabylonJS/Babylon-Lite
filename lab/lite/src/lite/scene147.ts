// Scene 147 — Circle of Confusion post-process showcase.
//
// Port of https://playground.babylonjs.com/#SUEU9U#117: the Babylon.js
// PowerPlant model (converted to glb) is rendered through the new frame-graph
// GeometryRendererTask to produce a normalized view-depth texture, which feeds
// the CircleOfConfusion post-process. The output is the grayscale CoC map:
// 0 (black) where the scene is in focus, 1 (white) where maximally out of focus.
// Camera and CoC parameters match the playground. The colour render is computed
// but unused by the CoC shader (matches the BJS reference structure).

import {
    addTask,
    addToScene,
    attachControl,
    createCircleOfConfusionPostProcessTask,
    createDefaultCamera,
    createEngine,
    createGeometryRendererTask,
    createHemisphericLight,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
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

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.5));
    addToScene(scene, await loadGltf(engine, POWERPLANT_URL));

    // Auto-frame the camera to the model bounds (matches BJS createDefaultCameraOrLight),
    // then apply the playground's orbit angles. minZ/maxZ stay at the auto values.
    const camera = createDefaultCamera(scene);
    camera.alpha = -3.12;
    camera.beta = 1.3;
    camera.radius = 75.63;
    attachControl(camera, canvas, scene);

    const sampleCount = 1;

    // Offscreen colour target (CoC source — sampled by the framework, ignored by
    // the shader). It is depth-less: the colour pass reuses the geometry task's
    // depth buffer (wired via the render task's `depth` field below) instead of
    // allocating its own, matching the BJS reference (renderTask.depthTexture =
    // geomTask.outputDepthTexture).
    const colorTarget = createRenderTarget({
        lbl: "scene147-color",
        format: engine.format,
        samples: sampleCount,
        size: engine,
    });
    const scRT = engine.scRT;

    // Geometry renderer → normalized view depth ([0,1], r16float, filterable by
    // the post-process bilinear sampler). The CoC reconstructs camera distance
    // from this via cameraMinMaxZ (camera near/far). The background (no geometry)
    // clears to 1 (far) in both Lite and BJS, keeping the CoC map in parity.
    const geomTask = createGeometryRendererTask(
        {
            name: "scene147-geom",
            samples: sampleCount,
            textureDescriptions: [{ type: GeometryTextureType.NORMALIZED_VIEW_DEPTH }],
        },
        engine,
        scene
    );

    // Reuse the geometry pass's depth buffer for the colour pass (depth field)
    // instead of allocating a second one — the geometry renderer already wrote a
    // full depth buffer, so the colour pass loads it. Mirrors the BJS ref.
    const sceneTask = createRenderTask(
        {
            name: "scene147-scene",
            rt: colorTarget,
            depth: geomTask.geometryDepthTexture,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );

    const cocTask = createCircleOfConfusionPostProcessTask(
        {
            name: "scene147-coc",
            sourceTexture: colorTarget,
            depthTexture: geomTask.geometryNormalizedViewDepthTexture!,
            camera,
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
    addTask(scene, cocTask);

    await registerScene(scene);
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
