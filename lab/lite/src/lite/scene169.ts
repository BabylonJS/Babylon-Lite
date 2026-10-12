// Scene 169: depth-aware compute flame, ported from Playground #KOBPUW#18.

import {
    addComputeDispatch,
    addMeshToTask,
    addTask,
    addToScene,
    attachControl,
    computeSamplerBinding,
    computeStorageTextureBinding,
    computeTextureBinding,
    computeUniformBufferBinding,
    createArcRotateCamera,
    createComputeBindingSet,
    createComputeDispatch,
    createComputeSampler,
    createComputeShader,
    createComputeStorageTexture2D,
    createComputeTask,
    createComputeTextureResource,
    createComputeUniformArena,
    createComputeUniformLayout,
    createComputeUniformWriter,
    createCylinder,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createGround,
    createHemisphericLight,
    createPcfSpotlightShadowGenerator,
    createRenderTargetTexture,
    createRenderTask,
    createSceneContext,
    createSpotLight,
    createStandardMaterial,
    createTexture2DFromPixels,
    getEffectiveAspectRatio,
    getViewMatrix,
    getViewProjectionMatrix,
    onBeforeRender,
    registerSceneWithShadowSupport,
    setComputeUniformF32,
    setComputeUniformVector,
    setEffectTexture,
    setShadowTaskCasterMeshes,
    startEngine,
    withSampledDepthTexture,
} from "babylon-lite";
import type { ArcRotateCamera, Mat4 } from "babylon-lite";
import { buildScene169NoisePixels, SCENE169_FLAME_POSITION, SCENE169_LITE_FLAME_COMPUTE_WGSL, SCENE169_NOISE_SIZE, SCENE169_SEEK_TIME } from "../shared/scene169-compute-flame.js";

const PRESENT_WGSL = `@group(0) @binding(0) var flameTexture:texture_2d<f32>;
@group(0) @binding(1) var flameSampler:sampler;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4f{return textureSample(flameTexture,flameSampler,vec2f(input.uv.x,1.0-input.uv.y));}`;

function projectFlame(camera: ArcRotateCamera, width: number, height: number, output: Float32Array): void {
    const [x, y, z] = SCENE169_FLAME_POSITION;
    const aspect = getEffectiveAspectRatio(camera, width, height);
    const vp = getViewProjectionMatrix(camera, aspect) as unknown as Mat4;
    const view = getViewMatrix(camera) as unknown as Mat4;
    const clipX = x * vp[0]! + y * vp[4]! + z * vp[8]! + vp[12]!;
    const clipY = x * vp[1]! + y * vp[5]! + z * vp[9]! + vp[13]!;
    const clipZ = x * vp[2]! + y * vp[6]! + z * vp[10]! + vp[14]!;
    const clipW = x * vp[3]! + y * vp[7]! + z * vp[11]! + vp[15]!;
    output[0] = (clipX / clipW + 1) * 0.5 * width;
    output[1] = (1 - clipY / clipW) * 0.5 * height;
    output[2] = clipZ / clipW;
    output[3] = x * view[2]! + y * view[6]! + z * view[10]! + view[14]!;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 10, { x: 0, y: 1.25, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 20;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.4));
    const spot = createSpotLight([2, 4, 2], [-1, -2, -1], 3, 1);
    spot.range = 12;
    addToScene(scene, spot);

    const ground = createGround(engine, { width: 8, height: 8 });
    ground.position.y = -0.1;
    ground.receiveShadows = true;
    const groundMaterial = createStandardMaterial();
    groundMaterial.diffuseColor = [0.16, 0.13, 0.1];
    groundMaterial.specularColor = [0.04, 0.04, 0.04];
    ground.material = groundMaterial;
    addToScene(scene, ground);

    const candle = createCylinder(engine, { height: 3, diameter: 1.45, tessellation: 64 });
    candle.position.y = 1.4;
    candle.receiveShadows = true;
    const candleMaterial = createStandardMaterial();
    candleMaterial.diffuseColor = [0.86, 0.72, 0.42];
    candleMaterial.specularColor = [0.12, 0.1, 0.06];
    candle.material = candleMaterial;
    addToScene(scene, candle);

    const wick = createCylinder(engine, { height: 0.34, diameter: 0.1, tessellation: 16 });
    wick.position.set(0, 3.02, 0);
    const wickMaterial = createStandardMaterial();
    wickMaterial.diffuseColor = [0.035, 0.025, 0.02];
    wickMaterial.specularColor = [0, 0, 0];
    wick.material = wickMaterial;
    addToScene(scene, wick);

    spot.shadowGenerator = createPcfSpotlightShadowGenerator(engine, spot, { mapSize: 1024, bias: 0.01, near: 0.1, far: 12 });
    setShadowTaskCasterMeshes(spot.shadowGenerator, [candle, wick]);

    const width = canvas.width;
    const height = canvas.height;
    const source = createRenderTargetTexture(
        engine,
        {
            lbl: "scene169-source",
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width, height },
        },
        withSampledDepthTexture
    );
    if (!source.depthTexture) {
        throw new Error("Scene 169 requires a sampled depth attachment.");
    }
    const sourceTask = createRenderTask({ name: "scene169-source", rt: source.rt, clrColor: scene.clearColor, clr: true, autoMirror: false }, engine, scene);
    addMeshToTask(sourceTask, ground);
    addMeshToTask(sourceTask, candle);
    addMeshToTask(sourceTask, wick);

    const sourceTexture = await createComputeTextureResource(engine, source.texture);
    const depthTexture = await createComputeTextureResource(engine, source.depthTexture);
    const noiseTexture = createTexture2DFromPixels(engine, buildScene169NoisePixels(), SCENE169_NOISE_SIZE, SCENE169_NOISE_SIZE, {
        addressModeU: "repeat",
        addressModeV: "repeat",
        minFilter: "linear",
        magFilter: "linear",
    });
    const noiseResource = await createComputeTextureResource(engine, noiseTexture);
    const noiseSampler = createComputeSampler(engine, {
        addressModeU: "repeat",
        addressModeV: "repeat",
        minFilter: "linear",
        magFilter: "linear",
    });
    const output = createComputeStorageTexture2D(engine, { width, height, format: "rgba8unorm", invertY: false, label: "scene169-output" });

    const computeTask = createComputeTask(engine, "scene169-flame");
    const uniformLayout = createComputeUniformLayout([
        { name: "posFlame", type: "vec4<f32>" },
        { name: "elapsedTime", type: "f32" },
    ]);
    const uniformArena = createComputeUniformArena(computeTask, uniformLayout.byteLength, 1, { label: "scene169-params" });
    const uniformWriter = createComputeUniformWriter(uniformArena, 0, uniformLayout);
    const shader = createComputeShader(engine, {
        name: "scene169-flame",
        computeSource: SCENE169_LITE_FLAME_COMPUTE_WGSL,
        bindings: [
            computeTextureBinding("source", { group: 0, binding: 0 }),
            computeStorageTextureBinding("output", { group: 0, binding: 1, format: "rgba8unorm" }),
            computeSamplerBinding("noiseSampler", { group: 0, binding: 2 }),
            computeTextureBinding("noiseTexture", { group: 0, binding: 3 }),
            computeUniformBufferBinding("params", { group: 0, binding: 4, minBindingSize: uniformLayout.byteLength }),
            computeTextureBinding("depth", { group: 0, binding: 5, sampleType: "depth" }),
        ],
    });
    const bindings = createComputeBindingSet(shader, {
        source: sourceTexture,
        output,
        noiseSampler,
        noiseTexture: noiseResource,
        params: { buffer: uniformArena.buffer, size: uniformLayout.byteLength },
        depth: depthTexture,
    });
    addComputeDispatch(
        computeTask,
        createComputeDispatch(shader, bindings, {
            size: { x: Math.ceil(width / 16), y: Math.ceil(height / 16) },
        })
    );

    const presentEffect = createEffectWrapper(engine, {
        name: "scene169-present",
        fragmentWGSL: PRESENT_WGSL,
        bindings: [
            { name: "flameTexture", binding: 0, kind: "texture" },
            { name: "flameSampler", binding: 1, kind: "sampler", textureBinding: "flameTexture" },
        ],
    });
    setEffectTexture(presentEffect, "flameTexture", output.sampledTexture);
    const presentTask = createEffectRenderTask({ name: "scene169-present", effect: presentEffect, target: engine.scRT }, engine, scene);

    addTask(scene, sourceTask);
    addTask(scene, computeTask);
    addTask(scene, presentTask);

    const params = new URLSearchParams(window.location.search);
    const animateValue = params.get("animate");
    const animated = animateValue !== null && animateValue !== "false" && animateValue !== "0";
    const seekValue = params.get("seekTime");
    const initialTime = seekValue === null ? SCENE169_SEEK_TIME : Number(seekValue);
    if (!Number.isFinite(initialTime)) {
        throw new Error(`Scene 169: seekTime must be finite, received "${seekValue}".`);
    }
    let elapsedTime = initialTime;
    const projectedFlame = new Float32Array(4);
    onBeforeRender(scene, (deltaMs) => {
        if (animated) {
            elapsedTime += deltaMs / 1000;
        }
        projectFlame(camera, width, height, projectedFlame);
        setComputeUniformVector(uniformWriter, "posFlame", projectedFlame);
        setComputeUniformF32(uniformWriter, "elapsedTime", elapsedTime);
    });

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.flameAnimated = String(animated);
    if (!animated) {
        canvas.dataset.animationFrozen = "true";
    }
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
