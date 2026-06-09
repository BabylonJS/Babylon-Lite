// BJS reference for scene 146 — Khronos Sponza glTF rendered via the FrameGraph API,
// with eleven geometry-texture impostors. This is the parity target for the Lite
// implementation. BJS supports PBR geometry rendering natively (FrameGraphGeometryRendererTask
// + the regular PBR fragment shader), so this reference exercises exactly what Lite needs
// once the PBR geometry-output path lands.
//
// Camera is positioned INSIDE Sponza (mirrors scene 179 placement) so impostors show
// interior geometry data.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import "@babylonjs/loaders/glTF/2.0";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { WebGPURenderItemViewport } from "@babylonjs/core/Engines/WebGPU/webgpuBundleList";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.debugging";
import { Engine } from "@babylonjs/core/Engines/engine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";

const SPONZA_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Sponza/glTF/";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const useWebGPU = true;

    let engine: Engine | WebGPUEngine;
    if (useWebGPU) {
        engine = new WebGPUEngine(canvas, {
            antialias: true,
            adaptToDeviceRatio: true,
            deviceDescriptor: { requiredLimits: { maxColorAttachmentBytesPerSample: 128 } },
            enableGPUDebugMarkers: true,
        });
        await engine.initAsync();
    } else {
        engine = new Engine(canvas, true);
    }

    engine.useReverseDepthBuffer = true;

    if (engine.isWebGPU) {
        // Mirror the viewport-rounding patch from scene 145 — same parity rationale.
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
    }

    const scene = new Scene(engine);
    scene.useRightHandedSystem = false;
    scene.skipPointerMovePicking = true;
    scene.environmentTexture = new CubeTexture("https://assets.babylonjs.com/environments/environmentSpecular.env", scene);

    // Mirror Lite's loadEnvironment() image-processing setup so the main forward-rendered
    // view matches: tone mapping (STANDARD), exposure 0.8, contrast 1.2.
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;

    (window as any).scene = scene;

    await SceneLoader.AppendAsync(SPONZA_URL, "Sponza.gltf", scene);

    // Inside-Sponza camera matching scene 179 placement.
    const camera = new FreeCamera("camera", new Vector3(-5, 2, 0), scene);
    camera.setTarget(new Vector3(0, 3, 0));
    camera.speed = 0.2;
    scene.activeCamera = camera;
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

    const geomTaskB = new FrameGraphGeometryRendererTask("geomRendererB", frameGraph, scene);
    geomTaskB.depthTexture = geomTaskA.outputDepthTexture;
    geomTaskB.camera = camera;
    geomTaskB.objectList = rlist;
    geomTaskB.samples = samples;
    geomTaskB.textureDescriptions = [
        { type: Constants.PREPASS_LOCAL_POSITION_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
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
