// BJS reference for scene 148 — Depth of Field post-process.
//
// Parity target for the Lite implementation. Port of
// https://playground.babylonjs.com/#SUEU9U#120: the PowerPlant model (glb) is
// rendered through the geometry renderer to a camera-space view-depth texture
// (PREPASS_DEPTH), which feeds a FrameGraphDepthOfFieldTask (depthNotNormalized
// path). With a near focus distance and a wide aperture the foreground stays
// sharp while the rest of the plant falls progressively out of focus. Camera
// and lens parameters match the playground and the Lite scene exactly.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Loading/loadingScreen";
import { AppendSceneAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/loaders/glTF/2.0";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphDepthOfFieldTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/depthOfFieldTask";
import { ThinDepthOfFieldEffectBlurLevel } from "@babylonjs/core/PostProcesses/thinDepthOfFieldEffect";
import { WebGPURenderItemViewport } from "@babylonjs/core/Engines/WebGPU/webgpuBundleList";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";

const POWERPLANT_URL = "https://assets.babylonjs.com/meshes/PowerPlant/powerplant.glb";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, {
        antialias: true,
        adaptToDeviceRatio: true,
    });
    await engine.initAsync();

    engine.useReverseDepthBuffer = true;

    // Mirror the viewport-rounding patch from scenes 145/146/147 — same parity rationale.
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

    await AppendSceneAsync(POWERPLANT_URL, scene);

    // Auto-frame to model bounds (matches Lite createDefaultCamera). The glb ships
    // a single directional light, so createDefaultCameraOrLight adds no light here;
    // we just apply the playground's orbit angles + bump that light's intensity.
    scene.createDefaultCameraOrLight(true, true, true);
    const camera = scene.activeCamera as ArcRotateCamera;
    camera.wheelPrecision = 10;
    camera.alpha = -2.646;
    camera.beta = 1.313;
    camera.radius = 109.071;

    // The playground does not add an extra light; it just bumps the default light.
    scene.lights[0]!.intensity = 2;

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

    const clearTask = new FrameGraphClearTextureTask("clear", frameGraph);
    clearTask.clearColor = true;
    clearTask.clearDepth = true;
    clearTask.targetTexture = colorTexture;
    clearTask.depthTexture = depthTexture;
    frameGraph.addTask(clearTask);

    // Separate single-sample depth for the geometry renderer (its colour render
    // is MSAA, but the view-depth output is kept single-sample — see Lite scene).
    const geomDepthTexture = frameGraph.textureManager.createRenderTargetTexture("geomDepth", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["geomDepth"],
        },
        sizeIsPercentage: true,
    });

    const clearGeomDepthTask = new FrameGraphClearTextureTask("clearGeomDepth", frameGraph);
    clearGeomDepthTask.clearColor = false;
    clearGeomDepthTask.clearDepth = true;
    clearGeomDepthTask.depthTexture = geomDepthTexture;
    frameGraph.addTask(clearGeomDepthTask);

    const rlist = { meshes: scene.meshes, particleSystems: scene.particleSystems };

    const geomTask = new FrameGraphGeometryRendererTask("geomRenderer", frameGraph, scene);
    geomTask.depthTexture = clearGeomDepthTask.outputDepthTexture;
    geomTask.camera = camera;
    geomTask.objectList = rlist;
    geomTask.samples = 1;
    geomTask.textureDescriptions = [{ type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED }];
    frameGraph.addTask(geomTask);

    const renderTask = new FrameGraphObjectRendererTask("renderObjects", frameGraph, scene);
    renderTask.targetTexture = clearTask.outputTexture;
    renderTask.depthTexture = clearTask.outputDepthTexture;
    renderTask.objectList = rlist;
    renderTask.camera = camera;
    frameGraph.addTask(renderTask);

    const ppTask = new FrameGraphDepthOfFieldTask("pp", frameGraph, ThinDepthOfFieldEffectBlurLevel.High, false);
    ppTask.sourceTexture = renderTask.outputTexture;
    ppTask.camera = camera;
    ppTask.depthTexture = geomTask.geometryViewDepthTexture!;
    ppTask.depthOfField.focusDistance = 80000;
    ppTask.depthOfField.fStop = 0.04;
    frameGraph.addTask(ppTask);

    const copyToBackbufferTask = new FrameGraphCopyToBackbufferColorTask("copytobackbuffer", frameGraph);
    copyToBackbufferTask.sourceTexture = ppTask.outputTexture;
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
