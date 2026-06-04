// Scene 145: HillValley.babylon rendered through the new frame-graph geometry renderer task,
// with eleven geometry-texture impostors copied along the top edge using createCopyToTextureTask.
// Mirrors the BJS reference scene which is itself a port of Playground #ARI9J5#6
// (without the FrameGraphGUITask overlays). The 11 prepass textures exceed the WebGPU 8-color-
// attachment cap, so they are split across two GeometryRendererTasks (7 + 4).

import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachFreeControl,
    createCopyToTextureTask,
    createEngine,
    createGeometryRendererTask,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    GeometryTextureType,
    loadBabylon,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { FreeCamera } from "babylon-lite";

const HILLVALLEY_URL = "https://www.babylonjs.com/Scenes/hillvalley/HillValley.babylon";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, {
        // Two MRTs at up to 7 attachments each — well under the WebGPU 8-attachment cap
        // but exceeding the default 32-byte-per-sample limit when 7 attachments are active.
        requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
    });
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    addToScene(scene, await loadBabylon(engine, HILLVALLEY_URL));

    const camera = scene.camera as FreeCamera;
    camera.position.set(-26.695675321687403, 2.7769661153192278, 21.145217983348115);
    camera.target.set(-27.038161178180832, 2.7243780642457263, 20.20716786084526);
    attachFreeControl(camera, canvas, scene);

    const samples = engine.msaaSamples as 1 | 4;

    // Intermediate offscreen target — main scene + impostor strip composite here.
    // Offscreen RTs render with a Y-flipped projection automatically (matches BJS
    // WebGPU's render-to-RT behavior at webgpuEngine.js:2729,2756). The mirrored
    // rasterization changes 2×2 fragment-quad coverage at triangle silhouettes,
    // which produces ~0.30 MAD of edge-jitter vs. the unmirrored path. To match
    // the BJS frame-graph reference (which always uses the mirrored RT path),
    // BL's intermediate RTs also mirror — no explicit flag needed.
    const intermediateTarget = createRenderTarget({
        label: "scene145-intermediate",
        colorFormat: engine.format,
        depthStencilFormat: "depth24plus-stencil8",
        sampleCount: samples,
        size: "canvas",
    });
    // Single-sample staging target used by the final shader-blit to the swap.
    // We could hardware-resolve the MSAA intermediate straight to the swap with
    // a single resolveTexture pass, but BJS's FrameGraph has no resolveTexture
    // option on its CopyToTexture / CopyToBackbufferColor tasks: it always does
    // an MSAA → SS hardware resolve into an internal SS target and then a
    // separate bilinear shader-blit (`textureSampleLevel` + linear sampler) to
    // the backbuffer. The shader-blit introduces ~0.3 MAD of sub-pixel jitter
    // across the frame vs. the direct hardware-resolve path. To match the
    // reference output we intentionally take the same extra hop here.
    const ssIntermediate = createRenderTarget({
        label: "scene145-ss-intermediate",
        colorFormat: engine.format,
        sampleCount: 1,
        size: "canvas",
    });
    // Final swapchain target — receives the composite via a closing copy task.
    const swapchainTarget = createRenderTarget({
        label: "scene145-swap",
        colorFormat: engine.format,
        sampleCount: 1,
        size: "canvas",
        resolveToSwapchain: true,
    });
    // Real-color target written by geomTaskA's targetTexture pass — collects
    // the actual lit material color alongside the geometry-data attachments,
    // and is displayed as one of the impostors below to demonstrate the
    // GeometryRendererTask.targetTexture feature.
    const realColorTarget = createRenderTarget({
        label: "scene145-real-color",
        colorFormat: engine.format,
        sampleCount: samples,
        size: "canvas",
    });
    const sceneTask = createRenderTask(
        {
            name: "scene145-scene",
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
            name: "scene145-geom-a",
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
            // Real-color output: the lit material color is written into
            // `realColorTarget` alongside the 7 geometry-data attachments.
            // `targetTextureClearColor` initialises the target so background
            // pixels (sky, etc.) show through with a known colour.
            targetTexture: realColorTarget,
            targetTextureClearColor: { r: 0, g: 0, b: 0, a: 1 },
        },
        engine,
        scene
    );
    const geomTaskB = createGeometryRendererTask(
        {
            name: "scene145-geom-b",
            samples,
            textureDescriptions: [
                { type: GeometryTextureType.LOCAL_POSITION },
                // r16float instead of the default r32float — r32 isn't
                // blendable or MSAA-resolvable in WebGPU, but the geometry
                // pipeline applies per-attachment alpha-blending and the MRT
                // is MSAA-resolved to single-sample wrappers downstream.
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

    // Impostors are split between bottom and top edges:
    //  - bottom: the original six attachments scene 145 always displayed.
    //  - top:    the five attachments added when extending coverage to all 11
    //            geometry texture types.
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
        // Real-color attachment written by geomTaskA via its targetTexture.
        // This is the actual lit material color (same shader as the regular
        // scene render) — bundled into the geometry MRT pass so we render
        // 11 geometry textures + the lit colour in one go.
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
                        name: `scene145-impostor-${entry.name}`,
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

    // Final composite → swap. Two-step to mirror BJS's reference pipeline:
    //   (1) MSAA intermediate → SS intermediate (hardware MSAA resolve)
    //   (2) SS intermediate   → swap            (bilinear shader blit)
    // For MSAA we keep both steps; for single-sample we skip the resolve and
    // just shader-blit intermediate → swap. See the comment on `ssIntermediate`
    // above for why we don't hardware-resolve straight to the swap.
    if (samples > 1) {
        addTask(
            scene,
            createCopyToTextureTask(
                {
                    name: "scene145-resolve",
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
                name: "scene145-to-swap",
                sourceTexture: samples > 1 ? ssIntermediate : intermediateTarget,
                targetTexture: swapchainTarget,
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
