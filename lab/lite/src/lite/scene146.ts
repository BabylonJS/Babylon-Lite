// Scene 146: Khronos Sponza glTF rendered through the new frame-graph geometry renderer task,
// with the same eleven geometry-texture impostors strip as Scene 145. Sponza is fully PBR
// (every mesh uses a glTF PBR material), so this scene exercises the PBR geometry-output path
// that mirrors the Standard one used by Scene 145.
//
// Camera is positioned INSIDE the Sponza model so the impostors show interior geometry data.

import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachFreeControl,
    createCopyToTextureTask,
    createEngine,
    createFreeCamera,
    createGeometryRendererTask,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    GeometryTextureType,
    loadEnvironment,
    loadGltf,
    registerScene,
    startEngine,
} from "babylon-lite";

const SPONZA_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Sponza/glTF/Sponza.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, {
        // Two MRTs at up to 7 attachments each — well under the WebGPU 8-attachment cap
        // but exceeding the default 32-byte-per-sample limit when 7 attachments are active.
        requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
    });
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    // Camera inside Sponza. Mirrors scene 179 placement so the camera stands in the central
    // courtyard and looks toward one of the inner colonnades.
    const camera = createFreeCamera({ x: -5, y: 2, z: 0 }, { x: 0, y: 3, z: 0 });
    camera.speed = 0.2;
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);

    addToScene(scene, await loadGltf(engine, SPONZA_URL));
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        brdfUrl: "/brdf-lut.png",
    });

    const samples = engine.msaaSamples as 1 | 4;

    // Intermediate offscreen target — main scene + impostor strip composite here.
    const intermediateTarget = createRenderTarget({
        lbl: "scene146-intermediate",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: samples,
        size: "canvas",
    });
    const ssIntermediate = createRenderTarget({
        lbl: "scene146-ss-intermediate",
        format: engine.format,
        samples: 1,
        size: "canvas",
    });
    const scRT = engine.scRT;
    const realColorTarget = createRenderTarget({
        lbl: "scene146-real-color",
        format: engine.format,
        samples: samples,
        size: "canvas",
    });
    const sceneTask = createRenderTask(
        {
            name: "scene146-scene",
            rt: intermediateTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );

    // Geometry renderer tasks — split into two so we stay under the WebGPU
    // per-pass color-attachment cap (8). Task A holds 7 attachments, task B
    // holds the remaining 4. Each owns its own depth.
    const geomTaskA = createGeometryRendererTask(
        {
            name: "scene146-geom-a",
            samples,
            textureDescriptions: [
                { type: GeometryTextureType.IRRADIANCE },
                { type: GeometryTextureType.WORLD_POSITION },
                { type: GeometryTextureType.NORMALIZED_VIEW_DEPTH },
                { type: GeometryTextureType.VIEW_NORMAL },
                { type: GeometryTextureType.WORLD_NORMAL },
                { type: GeometryTextureType.REFLECTIVITY },
                { type: GeometryTextureType.ALBEDO },
            ],
            targetTexture: realColorTarget,
            targetTextureClearColor: { r: 0, g: 0, b: 0, a: 1 },
        },
        engine,
        scene
    );
    const geomTaskB = createGeometryRendererTask(
        {
            name: "scene146-geom-b",
            samples,
            textureDescriptions: [
                { type: GeometryTextureType.LOCAL_POSITION },
                { type: GeometryTextureType.VIEW_DEPTH, format: "r16float" },
                { type: GeometryTextureType.SCREENSPACE_DEPTH },
                { type: GeometryTextureType.LINEAR_VELOCITY },
            ],
        },
        engine,
        scene
    );

    addTaskAtStart(scene, sceneTask);
    addTask(scene, geomTaskA);
    addTask(scene, geomTaskB);

    const bottomImpostors = [
        { name: "normViewDepth", source: geomTaskA.geometryNormalizedViewDepthTexture! },
        { name: "viewNormal", source: geomTaskA.geometryViewNormalTexture! },
        { name: "worldNormal", source: geomTaskA.geometryWorldNormalTexture! },
        { name: "worldPosition", source: geomTaskA.geometryWorldPositionTexture! },
        { name: "reflectivity", source: geomTaskA.geometryReflectivityTexture! },
        { name: "albedo", source: geomTaskA.geometryAlbedoTexture! },
    ];
    const topImpostors = [
        { name: "irradiance", source: geomTaskA.geometryIrradianceTexture! },
        { name: "localPosition", source: geomTaskB.geometryLocalPositionTexture! },
        { name: "viewDepth", source: geomTaskB.geometryViewDepthTexture! },
        { name: "screenspaceDepth", source: geomTaskB.geometryScreenspaceDepthTexture! },
        { name: "linearVelocity", source: geomTaskB.geometryLinearVelocityTexture! },
        { name: "realColor", source: geomTaskA.outputTexture! },
    ];
    const placeStrip = (strip: { name: string; source: typeof intermediateTarget }[], y: number) => {
        const tileW = 1 / strip.length;
        for (let i = 0; i < strip.length; i++) {
            const entry = strip[i]!;
            addTask(
                scene,
                createCopyToTextureTask(
                    {
                        name: `scene146-impostor-${entry.name}`,
                        sourceTexture: entry.source,
                        targetTexture: intermediateTarget,
                        viewport: { x: i * tileW, y, width: tileW, height: 0.15 },
                    },
                    engine,
                    scene
                )
            );
        }
    };
    placeStrip(bottomImpostors, 0);
    placeStrip(topImpostors, 0.85);

    if (samples > 1) {
        addTask(
            scene,
            createCopyToTextureTask(
                {
                    name: "scene146-resolve",
                    sourceTexture: intermediateTarget,
                    resolveTexture: ssIntermediate,
                },
                engine,
                scene
            )
        );
    }
    addTask(
        scene,
        createCopyToTextureTask(
            {
                name: "scene146-to-swap",
                sourceTexture: samples > 1 ? ssIntermediate : intermediateTarget,
                targetTexture: scRT,
            },
            engine,
            scene
        )
    );

    await registerScene(engine, scene);
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
