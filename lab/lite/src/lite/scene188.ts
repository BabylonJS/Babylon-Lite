import {
    addComputeDispatch,
    addTaskAtStart,
    addToScene,
    computeStorageBufferBinding,
    computeTextureViewBinding,
    createArcRotateCamera,
    createComputeBindingSet,
    createComputeDispatch,
    createComputeOneShot,
    createComputeShader,
    createComputeTask,
    createComputeTextureViewResource,
    createEngine,
    createMeshFromStorageBuffer,
    createSceneContext,
    createShaderMaterial,
    createStorageBuffer,
    createTexture2DArrayFromPixels,
    createTexture3DFromPixels,
    registerScene,
    setShaderAttributeFormats,
    startEngine,
    wgsl,
} from "babylon-lite";
import {
    buildScene188Indices,
    buildScene188Noise,
    SCENE188_CHUNKS,
    SCENE188_CHUNK_ORIGINS,
    SCENE188_COMPUTE_WGSL,
    SCENE188_FRAGMENT_WGSL,
    SCENE188_GRID,
    SCENE188_NOISE_SIZE,
    SCENE188_STRIDE,
    SCENE188_VERTS_PER_CHUNK,
    SCENE188_VERTS_TOTAL,
    SCENE188_VERTEX_WGSL,
} from "../shared/scene188-compute-geometry.js";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 51 / 255, g: 51 / 255, b: 76 / 255, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3.1, 7.5, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    const slab = createStorageBuffer(engine, SCENE188_VERTS_TOTAL * SCENE188_STRIDE, { writable: true, vertex: true, label: "scene188-terrain" });
    const params = new Float32Array(SCENE188_CHUNKS * 4);
    for (let i = 0; i < SCENE188_CHUNKS; i++) {
        params[i * 4] = SCENE188_CHUNK_ORIGINS[i]![0];
        params[i * 4 + 1] = SCENE188_CHUNK_ORIGINS[i]![1];
        params[i * 4 + 2] = i * 0.18 - 0.27;
    }
    const paramsBuffer = createStorageBuffer(engine, params, { label: "scene188-params" });
    const noise = buildScene188Noise();
    const noiseTexture = createTexture3DFromPixels(engine, noise, SCENE188_NOISE_SIZE, SCENE188_NOISE_SIZE, SCENE188_NOISE_SIZE, { filter: "nearest" });
    const noiseResource = await createComputeTextureViewResource(engine, noiseTexture, { viewDimension: "3d" });
    const noiseArray = createTexture2DArrayFromPixels(engine, noise, SCENE188_NOISE_SIZE, SCENE188_NOISE_SIZE, SCENE188_NOISE_SIZE, {
        mipMaps: false,
        minFilter: "nearest",
        magFilter: "nearest",
    });
    const noiseArrayResource = await createComputeTextureViewResource(engine, noiseArray, { viewDimension: "2d-array" });

    const shader = createComputeShader(engine, {
        name: "scene188-fill",
        computeSource: SCENE188_COMPUTE_WGSL,
        bindings: [
            computeStorageBufferBinding("params", { group: 0, binding: 0 }),
            computeStorageBufferBinding("slab", { group: 0, binding: 1, access: "read-write" }),
            computeTextureViewBinding("noiseVolume", { group: 0, binding: 2, viewDimension: "3d" }),
            computeTextureViewBinding("noiseLayers", { group: 0, binding: 3, viewDimension: "2d-array" }),
        ],
    });
    const bindings = createComputeBindingSet(shader, { params: paramsBuffer, slab, noiseVolume: noiseResource, noiseLayers: noiseArrayResource });
    const computeTask = createComputeTask(engine, "scene188-fill");
    addComputeDispatch(computeTask, createComputeDispatch(shader, bindings, { size: { x: Math.ceil(SCENE188_VERTS_TOTAL / 64) } }));
    const oneShot = createComputeOneShot(computeTask);
    addTaskAtStart(scene, computeTask);

    const material = createShaderMaterial({
        name: "scene188-material",
        vertexSource: wgsl`${SCENE188_VERTEX_WGSL}`,
        fragmentSource: wgsl`${SCENE188_FRAGMENT_WGSL}`,
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
    });
    setShaderAttributeFormats(material, { position: "float32x4" });
    const indices = createStorageBuffer(engine, buildScene188Indices(), { index: true, label: "scene188-indices" });
    const indexCount = (SCENE188_GRID - 1) * (SCENE188_GRID - 1) * 6;
    for (let i = 0; i < SCENE188_CHUNKS; i++) {
        const [ox, oz] = SCENE188_CHUNK_ORIGINS[i]!;
        const mesh = createMeshFromStorageBuffer(engine, `chunk${i}`, {
            storage: slab,
            indices,
            indexFormat: "uint32",
            indexCount,
            vertexCount: SCENE188_VERTS_PER_CHUNK,
            arrayStride: SCENE188_STRIDE,
            baseVertex: i * SCENE188_VERTS_PER_CHUNK,
            boundMin: [ox, -0.5, oz],
            boundMax: [ox + 2, 0.5, oz + 2],
        });
        mesh.material = material;
        addToScene(scene, mesh);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.firstFrameCompute = String(computeTask.executionEnabled === false);
    await oneShot.completion;
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
