// Babylon.js reference for scene 169: depth-aware compute flame, ported from Playground #KOBPUW#18.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphComputeShaderTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/computeShaderTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { TextureSampler } from "@babylonjs/core/Materials/Textures/textureSampler";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { buildScene169NoisePixels, SCENE169_BJS_FLAME_COMPUTE_WGSL, SCENE169_FLAME_POSITION, SCENE169_NOISE_SIZE, SCENE169_SEEK_TIME } from "../shared/scene169-compute-flame.js";

void (async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3, 10, new Vector3(0, 1.25, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 20;
    camera.attachControl(canvas, true);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.4;
    const spot = new SpotLight("spot", new Vector3(2, 4, 2), new Vector3(-1, -2, -1), 3, 1, scene);
    spot.range = 12;

    const ground = MeshBuilder.CreateGround("ground", { width: 8, height: 8 }, scene);
    ground.position.y = -0.1;
    ground.receiveShadows = true;
    const groundMaterial = new StandardMaterial("ground-material", scene);
    groundMaterial.diffuseColor = new Color3(0.16, 0.13, 0.1);
    groundMaterial.specularColor = new Color3(0.04, 0.04, 0.04);
    ground.material = groundMaterial;

    const candle = MeshBuilder.CreateCylinder("candle", { height: 3, diameter: 1.45, tessellation: 64 }, scene);
    candle.position.y = 1.4;
    candle.receiveShadows = true;
    const candleMaterial = new StandardMaterial("candle-material", scene);
    candleMaterial.diffuseColor = new Color3(0.86, 0.72, 0.42);
    candleMaterial.specularColor = new Color3(0.12, 0.1, 0.06);
    candle.material = candleMaterial;

    const wick = MeshBuilder.CreateCylinder("wick", { height: 0.34, diameter: 0.1, tessellation: 16 }, scene);
    wick.position.set(0, 3.02, 0);
    const wickMaterial = new StandardMaterial("wick-material", scene);
    wickMaterial.diffuseColor = new Color3(0.035, 0.025, 0.02);
    wickMaterial.specularColor = Color3.Black();
    wick.material = wickMaterial;

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;

    const colorTexture = frameGraph.textureManager.createRenderTargetTexture("scene169-color", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene169-color"],
        },
        sizeIsPercentage: true,
    });
    const depthTexture = frameGraph.textureManager.createRenderTargetTexture("scene169-depth", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene169-depth"],
        },
        sizeIsPercentage: true,
    });
    const outputTexture = frameGraph.textureManager.createRenderTargetTexture("scene169-output", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            creationFlags: [Constants.TEXTURE_CREATIONFLAG_STORAGE],
            labels: ["scene169-output"],
        },
        sizeIsPercentage: true,
    });

    const clearTask = new FrameGraphClearTextureTask("scene169-clear", frameGraph);
    clearTask.clearColor = true;
    clearTask.clearDepth = true;
    clearTask.color.set(0, 0, 0, 1);
    clearTask.targetTexture = colorTexture;
    clearTask.depthTexture = depthTexture;
    frameGraph.addTask(clearTask);

    const shadowTask = new FrameGraphShadowGeneratorTask("scene169-shadow", frameGraph);
    shadowTask.camera = camera;
    shadowTask.objectList = { meshes: [candle, wick], particleSystems: [] };
    shadowTask.light = spot;
    shadowTask.mapSize = 1024;
    frameGraph.addTask(shadowTask);

    const renderTask = new FrameGraphObjectRendererTask("scene169-render", frameGraph, scene);
    renderTask.targetTexture = clearTask.outputTexture;
    renderTask.depthTexture = clearTask.outputDepthTexture;
    renderTask.objectList = { meshes: [ground, candle, wick], particleSystems: [] };
    renderTask.camera = camera;
    renderTask.shadowGenerators = [shadowTask];
    frameGraph.addTask(renderTask);

    const computeTask = new FrameGraphComputeShaderTask(
        "scene169-flame",
        frameGraph,
        { computeSource: SCENE169_BJS_FLAME_COMPUTE_WGSL },
        {
            bindingsMapping: {
                source: { group: 0, binding: 0 },
                output: { group: 0, binding: 1 },
                noiseSampler: { group: 0, binding: 2 },
                noiseTexture: { group: 0, binding: 3 },
                params: { group: 0, binding: 4 },
                depth: { group: 0, binding: 5 },
            },
        }
    );
    const uniform = computeTask.createUniformBuffer("params", { posFlame: 4, elapsedTime: 1 });
    const noiseTexture = RawTexture.CreateRGBATexture(buildScene169NoisePixels(), SCENE169_NOISE_SIZE, SCENE169_NOISE_SIZE, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    noiseTexture.wrapU = Texture.WRAP_ADDRESSMODE;
    noiseTexture.wrapV = Texture.WRAP_ADDRESSMODE;
    computeTask.setTexture("noiseTexture", noiseTexture, false);
    computeTask.setTextureSampler(
        "noiseSampler",
        new TextureSampler().setParameters(Texture.WRAP_ADDRESSMODE, Texture.WRAP_ADDRESSMODE, Texture.WRAP_ADDRESSMODE, 1, Texture.BILINEAR_SAMPLINGMODE)
    );

    frameGraph.onBuildObservable.add(() => {
        const source = frameGraph.textureManager.getTextureFromHandle(renderTask.outputTexture);
        const depth = frameGraph.textureManager.getTextureFromHandle(renderTask.outputDepthTexture);
        const output = frameGraph.textureManager.getTextureFromHandle(outputTexture);
        if (!source || !depth || !output) {
            throw new Error("Scene 169 frame-graph textures were not allocated.");
        }
        computeTask.dispatchSize.x = Math.ceil(output.width / 16);
        computeTask.dispatchSize.y = Math.ceil(output.height / 16);
        computeTask.setInternalTexture("source", source);
        computeTask.setInternalTexture("depth", depth);
        computeTask.setInternalTexture("output", output);
    });

    const params = new URLSearchParams(window.location.search);
    const animateValue = params.get("animate");
    const animated = animateValue !== null && animateValue !== "false" && animateValue !== "0";
    const seekValue = params.get("seekTime");
    const initialTime = seekValue === null ? SCENE169_SEEK_TIME : Number(seekValue);
    if (!Number.isFinite(initialTime)) {
        throw new Error(`Scene 169: seekTime must be finite, received "${seekValue}".`);
    }
    let elapsedTime = initialTime;
    const flamePosition = new Vector3(...SCENE169_FLAME_POSITION);
    computeTask.execute = () => {
        if (animated) {
            elapsedTime += engine.getDeltaTime() / 1000;
        }
        const projected = Vector3.Project(
            flamePosition,
            Matrix.IdentityReadOnly,
            camera.getTransformationMatrix(),
            new Viewport(0, 0, engine.getRenderWidth(true), engine.getRenderHeight(true))
        );
        const viewPosition = Vector3.TransformCoordinates(flamePosition, camera.getViewMatrix());
        uniform.updateFloat4("posFlame", projected.x, projected.y, projected.z, viewPosition.z);
        uniform.updateFloat("elapsedTime", elapsedTime);
    };
    frameGraph.addTask(computeTask);

    const copyTask = new FrameGraphCopyToBackbufferColorTask("scene169-present", frameGraph);
    copyTask.sourceTexture = outputTexture;
    frameGraph.addTask(copyTask);

    frameGraph.optimizeTextureAllocation = false;
    engine.onResizeObservable.add(async () => frameGraph.buildAsync());
    await frameGraph.buildAsync();

    const drawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => drawCalls._drawCalls?.fetchNewFrame());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(drawCalls._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.flameAnimated = String(animated);
    if (!animated) {
        canvas.dataset.animationFrozen = "true";
    }
    canvas.dataset.ready = "true";
})().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
