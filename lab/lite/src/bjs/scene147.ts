// BJS reference for scene 147 — Circle of Confusion post-process.
//
// Parity target for the Lite implementation. Port of
// https://playground.babylonjs.com/#SUEU9U#117: the PowerPlant model (glb) is
// rendered through the geometry renderer to a NORMALIZED view-depth texture
// (PREPASS_NORMALIZED_VIEW_DEPTH), which feeds a FrameGraphCircleOfConfusionTask
// (default normalized path, reconstructing camera distance from cameraMinMaxZ).
// Camera and CoC parameters match the playground and the Lite scene exactly.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Loading/loadingScreen";
import { AppendSceneAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/loaders/glTF/2.0";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphCircleOfConfusionTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/circleOfConfusionTask";
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

    // Mirror the viewport-rounding patch from scenes 145/146 — same parity rationale.
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

    // Auto-frame to model bounds (matches Lite createDefaultCamera), then apply the
    // playground's orbit angles. minZ/maxZ stay at the auto values (radius*0.01/1000).
    scene.createDefaultCameraOrLight(true, true, true);
    const camera = scene.activeCamera as ArcRotateCamera;
    camera.wheelPrecision = 2;
    camera.alpha = -3.12;
    camera.beta = 1.3;
    camera.radius = 75.63;

    const light = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), scene);
    light.intensity = 1.5;

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;

    const samples = 1;

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

    const rlist = { meshes: scene.meshes, particleSystems: scene.particleSystems };

    const geomTask = new FrameGraphGeometryRendererTask("geomRenderer", frameGraph, scene);
    geomTask.depthTexture = clearTask.depthTexture;
    geomTask.camera = camera;
    geomTask.objectList = rlist;
    geomTask.samples = samples;
    geomTask.textureDescriptions = [
        { type: Constants.PREPASS_NORMALIZED_VIEW_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
    ];
    frameGraph.addTask(geomTask);

    const renderTask = new FrameGraphObjectRendererTask("renderObjects", frameGraph, scene);
    renderTask.targetTexture = clearTask.outputTexture;
    renderTask.depthTexture = geomTask.outputDepthTexture;
    renderTask.objectList = rlist;
    renderTask.camera = camera;
    frameGraph.addTask(renderTask);

    const ppTask = new FrameGraphCircleOfConfusionTask("pp", frameGraph);
    ppTask.sourceTexture = renderTask.outputTexture;
    ppTask.camera = camera;
    ppTask.depthTexture = geomTask.geometryNormViewDepthTexture!;
    ppTask.postProcess.lensSize = 50;
    ppTask.postProcess.focalLength = 50;
    ppTask.postProcess.fStop = 0.04;
    ppTask.postProcess.focusDistance = 80000;
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
