// BJS reference for scene 145 — HillValley loaded through .babylon, rendered via the
// FrameGraph API, with eleven geometry-texture impostors copied along the top edge using
// FrameGraphCopyToTextureTask. Mirrors Playground #ARI9J5#6 minus the FrameGraphGUITask
// overlays (Lite has no GUI yet). Eleven prepass textures exceed WebGPU's 8-color-
// attachment per-pass cap, so they are split across two FrameGraphGeometryRendererTasks.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Loading/loadingScreen";
import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/loaders";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { WebGPURenderItemViewport } from "@babylonjs/core/Engines/WebGPU/webgpuBundleList";
import type { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, {
        antialias: true,
        adaptToDeviceRatio: true,
        deviceDescriptor: { requiredLimits: { maxColorAttachmentBytesPerSample: 128 } },
    });
    await engine.initAsync();

    engine.useReverseDepthBuffer = true;

    // BJS 9.5.0 FrameGraphObjectRendererTask unconditionally constructs ThinDepthPeelingRenderer,
    // which calls engine.buildTextureLayout() — a WebGL-only API. Stub it (OIT is not used here).
    (engine as unknown as { buildTextureLayout: (formats: unknown[]) => unknown[] }).buildTextureLayout = (formats: unknown[]) => formats.map(() => true);

    // Monkey-patch BJS WebGPU viewport rounding to remove the 1-px gaps that
    // `webgpuEngine._applyViewport` produces. The original applies `Math.floor`
    // to `x`, `y`, `w`, `h` independently, so at fractional boundaries (e.g.
    // 6 tiles at 1280px → width=213.33) two adjacent viewports can leave a
    // pixel uncovered (here x=639 between tiles 2 and 3) and the strip ends
    // 1 px short. Replacing `floor(w)` with `floor(x + w) − floor(x)` (the
    // "end-minus-start" variant) makes consecutive tiles share their boundary
    // pixel and matches Lite's copy-to-texture-task rounding so the parity
    // diff drops to noise.
    const engPatch = engine as unknown as {
        _viewportCached: { x: number; y: number; z: number; w: number };
        _currentRenderTarget: unknown;
        getRenderHeight: (useScreen?: boolean) => number;
        _getCurrentRenderPass: () => GPURenderPassEncoder;
        _applyViewport: (bundleList?: { addItem: (item: unknown) => void }) => void;
    };
    engPatch._applyViewport = function (bundleList) {
        const vc = engPatch._viewportCached;
        const x = Math.floor(vc.x);
        const w = Math.floor(vc.x + vc.z) - x;
        let y = Math.floor(vc.y);
        const h = Math.floor(vc.y + vc.w) - y;
        if (!engPatch._currentRenderTarget) {
            y = engPatch.getRenderHeight(true) - y - h;
        }
        if (bundleList) {
            bundleList.addItem(new WebGPURenderItemViewport(x, y, w, h));
        } else {
            engPatch._getCurrentRenderPass().setViewport(x, y, w, h, 0, 1);
        }
    };

    const scene = new Scene(engine);
    scene.useRightHandedSystem = false;
    scene.skipPointerMovePicking = true;

    (window as any).scene = scene;

    await SceneLoader.AppendAsync("https://www.babylonjs.com/Scenes/hillvalley/", "HillValley.babylon", scene);

    // Lite's .babylon loader bakes each mesh's `localMatrix` (pivot) into the
    // vertex positions and stores a TRS-only world matrix. BJS keeps the
    // original raw vertex positions and applies the pivot via
    // `setPreTransformMatrix` at vertex time, so the `LOCAL_POSITION` impostor
    // would disagree (different model-space coordinates per pivoted mesh).
    // Replicate Lite's bake here so both pipelines produce the same local
    // position; world positions stay identical because we also clear the
    // mesh pivot after baking.
    for (const m of scene.meshes) {
        const tn = m as unknown as { getPivotMatrix(): Matrix; setPivotMatrix(matrix: Matrix, post?: boolean): void; bakeTransformIntoVertices(t: Matrix): void };
        const pivot = tn.getPivotMatrix();
        if (!pivot.isIdentity()) {
            tn.bakeTransformIntoVertices(pivot);
            tn.setPivotMatrix(Matrix.Identity(), false);
        }
    }

    const camera = scene.activeCamera as UniversalCamera;
    camera.position.set(-26.695675321687403, 2.7769661153192278, 21.145217983348115);
    camera.setTarget(new Vector3(-27.038161178180832, 2.7243780642457263, 20.20716786084526));
    camera.attachControl(canvas, true);
    scene.cameraToUseForPointers = camera;

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;

    const samples = 4;

    const colorTexture = frameGraph.textureManager.createRenderTargetTexture("color", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples,
            useSRGBBuffers: [false],
            labels: ["color"],
        },
        sizeIsPercentage: true,
    });

    const depthTexture = frameGraph.textureManager.createRenderTargetTexture("depth", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples,
            useSRGBBuffers: [false],
            labels: ["depth"],
        },
        sizeIsPercentage: true,
    });

    // Real-color target written by geomTaskA's targetTexture pass — collects
    // the actual lit material colour alongside the geometry-data attachments,
    // and is displayed as one of the impostors below to demonstrate the
    // FrameGraphGeometryRendererTask.targetTexture feature.
    const realColorTexture = frameGraph.textureManager.createRenderTargetTexture("realColor", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples,
            useSRGBBuffers: [false],
            labels: ["realColor"],
        },
        sizeIsPercentage: true,
    });

    const finalOutputTexture = colorTexture;

    const clearTask = new FrameGraphClearTextureTask("clear", frameGraph);
    clearTask.clearColor = true;
    clearTask.clearDepth = true;
    clearTask.targetTexture = finalOutputTexture;
    clearTask.depthTexture = depthTexture;
    frameGraph.addTask(clearTask);

    // Pre-clear the real-color target so background pixels (sky etc.) have a
    // known starting colour before geomTaskA writes the lit colour over them.
    const clearRealColorTask = new FrameGraphClearTextureTask("clearRealColor", frameGraph);
    clearRealColorTask.clearColor = true;
    clearRealColorTask.clearDepth = false;
    clearRealColorTask.targetTexture = realColorTexture;
    frameGraph.addTask(clearRealColorTask);

    const rlist = {
        meshes: scene.meshes,
        particleSystems: scene.particleSystems,
    };

    const geomTaskA = new FrameGraphGeometryRendererTask("geomRendererA", frameGraph, scene);
    geomTaskA.depthTexture = clearTask.depthTexture;
    geomTaskA.camera = camera;
    geomTaskA.objectList = rlist;
    geomTaskA.samples = samples;
    // Real-color output: the lit material colour is written into
    // `realColorTexture` alongside the 7 geometry-data attachments.
    geomTaskA.targetTexture = clearRealColorTask.outputTexture;
    geomTaskA.textureDescriptions = [
        { type: Constants.PREPASS_IRRADIANCE_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_POSITION_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_NORMALIZED_VIEW_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
        { type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_ALBEDO_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    frameGraph.addTask(geomTaskA);

    // Second geometry task — reuses the depth output by the first to avoid re-clearing
    // (and to keep depth values consistent between passes).
    const geomTaskB = new FrameGraphGeometryRendererTask("geomRendererB", frameGraph, scene);
    geomTaskB.depthTexture = geomTaskA.outputDepthTexture;
    geomTaskB.camera = camera;
    geomTaskB.objectList = rlist;
    geomTaskB.samples = samples;
    geomTaskB.textureDescriptions = [
        { type: Constants.PREPASS_LOCAL_POSITION_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        // HALF_FLOAT instead of FLOAT — r32float isn't blendable or
        // MSAA-resolvable in WebGPU, but the BJS geometry MRT is
        // MSAA-resolved downstream and uses alpha-blending.
        { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
        { type: Constants.PREPASS_SCREENSPACE_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
        { type: Constants.PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    frameGraph.addTask(geomTaskB);

    const renderTask = new FrameGraphObjectRendererTask("renderObjects", frameGraph, scene);
    renderTask.targetTexture = clearTask.outputTexture;
    renderTask.depthTexture = geomTaskB.outputDepthTexture;
    renderTask.objectList = rlist;
    renderTask.camera = camera;
    frameGraph.addTask(renderTask);

    // Copy each geometry texture as a small impostor along the top edge.
    // Impostors are split between bottom and top edges:
    //  - bottom: the original six attachments scene 145 always displayed.
    //  - top:    the five attachments added when extending coverage to all 11
    //            geometry texture types.
    const bottomImpostors = [
        { name: "normViewDepth", source: geomTaskA.geometryNormViewDepthTexture! },
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
        { name: "screenspaceDepth", source: geomTaskB.geometryScreenDepthTexture! },
        { name: "linearVelocity", source: geomTaskB.geometryLinearVelocityTexture! },
        // Real-color attachment written by geomTaskA via its targetTexture.
        // This is the actual lit material colour (same shader as the regular
        // scene render) — bundled into the geometry MRT pass so we render
        // 11 geometry textures + the lit colour in one go.
        { name: "realColor", source: geomTaskA.outputTexture },
    ];
    let prevTexture: typeof renderTask.outputTexture = renderTask.outputTexture;
    const placeStrip = (strip: { name: string; source: typeof renderTask.outputTexture }[], y: number) => {
        const tileW = 1 / strip.length;
        for (let i = 0; i < strip.length; i++) {
            const entry = strip[i]!;
            const copy = new FrameGraphCopyToTextureTask(`copyImpostor-${entry.name}`, frameGraph);
            copy.sourceTexture = entry.source;
            copy.targetTexture = prevTexture;
            copy.viewport = { x: i * tileW, y, width: tileW, height: 0.15 };
            frameGraph.addTask(copy);
            prevTexture = copy.outputTexture;
        }
    };
    placeStrip(bottomImpostors, 0);
    placeStrip(topImpostors, 0.85);

    const copyToBackbufferTask = new FrameGraphCopyToBackbufferColorTask("copytobackbuffer", frameGraph);
    copyToBackbufferTask.sourceTexture = prevTexture;
    frameGraph.addTask(copyToBackbufferTask);

    frameGraph.optimizeTextureAllocation = false;

    engine.onResizeObservable.add(async () => {
        await frameGraph.buildAsync();
    });
    await frameGraph.buildAsync();

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
    for (let i = 0; i < 15; i++) {
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    }
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
