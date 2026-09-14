import {
    addComputeDispatch,
    addTaskAtStart,
    addToScene,
    computeStorageBufferBinding,
    computeStorageTextureViewBinding,
    createArcRotateCamera,
    createComputeBindingSet,
    createComputeDispatch,
    createComputeIndirectDispatch,
    createComputeOneShot,
    createComputeShader,
    createComputeStorageTexture,
    createComputeTask,
    createEngine,
    createMeshFromStorageBuffer,
    createSceneContext,
    createShaderMaterial,
    createStorageBuffer,
    registerScene,
    setShaderAttributeFormats,
    startEngine,
} from "babylon-lite";
import { wgsl } from "babylon-lite/shader/wgsl.js";
import {
    buildScene189Indices,
    SCENE189_ARGS_WGSL,
    SCENE189_FILL_WGSL,
    SCENE189_FRAGMENT_WGSL,
    SCENE189_STRIDE,
    SCENE189_VERTICES,
    SCENE189_VERTEX_WGSL,
} from "../shared/scene189-indirect.js";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.025, g: 0.04, b: 0.08, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3.1, 7.5, { x: 0, y: 0.3, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    const indirectArgs = createStorageBuffer(engine, 12, { writable: true, indirect: true, label: "scene189-indirect" });
    const state = await createComputeStorageTexture(engine, {
        width: 1,
        height: 1,
        depthOrArrayLayers: 1,
        viewDimension: "3d",
        format: "r32uint",
        access: "read-write",
        sampled: false,
        label: "scene189-state",
    });
    const vertices = createStorageBuffer(engine, SCENE189_VERTICES * SCENE189_STRIDE, { writable: true, vertex: true, label: "scene189-vertices" });

    const argsShader = createComputeShader(engine, {
        name: "scene189-args",
        computeSource: SCENE189_ARGS_WGSL,
        bindings: [
            computeStorageBufferBinding("indirectArgs", { group: 0, binding: 0, access: "read-write" }),
            computeStorageTextureViewBinding("state", { group: 0, binding: 1, format: "r32uint", access: "read-write", viewDimension: "3d" }),
        ],
    });
    const argsTask = createComputeTask(engine, "scene189-args");
    addComputeDispatch(argsTask, createComputeDispatch(argsShader, createComputeBindingSet(argsShader, { indirectArgs, state }), { size: { x: 1 } }));
    const argsOneShot = createComputeOneShot(argsTask);

    const fillShader = createComputeShader(engine, {
        name: "scene189-fill",
        computeSource: SCENE189_FILL_WGSL,
        bindings: [computeStorageBufferBinding("vertices", { group: 0, binding: 0, access: "read-write" })],
    });
    const fillTask = createComputeTask(engine, "scene189-fill");
    addComputeDispatch(fillTask, createComputeIndirectDispatch(fillShader, createComputeBindingSet(fillShader, { vertices }), { buffer: indirectArgs }));
    const fillOneShot = createComputeOneShot(fillTask);

    addTaskAtStart(scene, fillTask);
    addTaskAtStart(scene, argsTask);

    const material = createShaderMaterial({
        name: "scene189-material",
        vertexSource: wgsl`${SCENE189_VERTEX_WGSL}`,
        fragmentSource: wgsl`${SCENE189_FRAGMENT_WGSL}`,
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
        backFaceCulling: false,
    });
    setShaderAttributeFormats(material, { position: "float32x4" });
    const mesh = createMeshFromStorageBuffer(engine, "indirect-triangles", {
        storage: vertices,
        indices: buildScene189Indices(),
        vertexCount: SCENE189_VERTICES,
        arrayStride: SCENE189_STRIDE,
        boundMin: [-2.3, 0, -1.6],
        boundMax: [2.3, 0.85, 1.6],
    });
    mesh.material = material;
    addToScene(scene, mesh);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.firstFrameCompute = String(argsTask.executionEnabled === false && fillTask.executionEnabled === false);
    await Promise.all([argsOneShot.completion, fillOneShot.completion]);
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
