import {
    addComputeDispatch,
    addTaskAtStart,
    addToScene,
    computeStorageBufferBinding,
    computeUniformBufferBinding,
    createComputeBindingSet,
    createComputeDispatch,
    createComputeShader,
    createComputeTask,
    createEngine,
    createMeshFromStorageBuffer,
    createSceneContext,
    createShaderMaterial,
    createStorageBuffer,
    createUniformBuffer,
    getMeshIndexedDrawInfo,
    registerScene,
    setMeshIndexedIndirect,
    setShaderAttributeFormats,
    startEngine,
    updateUniformBuffer,
    wgsl,
} from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

async function main(): Promise<void> {
    const engine = await createEngine(canvas);
    const errors: string[] = [];
    engine._device.addEventListener("uncapturederror", (event) => {
        errors.push(event.error.message);
        canvas.dataset.gpuErrors = JSON.stringify(errors);
    });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };
    const vertices = createStorageBuffer(
        engine,
        new Float32Array([0, 0, 0, 1, -0.9, -0.8, 0, 1, -0.1, -0.8, 0, 1, -0.5, 0.8, 0, 1, 0.1, -0.8, 0, 1, 0.9, -0.8, 0, 1, 0.5, 0.8, 0, 1, 0, 0, 0, 1]),
        { vertex: true }
    );
    const args = createStorageBuffer(engine, 28, { writable: true, indirect: true });
    const other = createStorageBuffer(engine, 32, { writable: true, indirect: true });
    const control = createUniformBuffer(engine, new Uint32Array([1, 0, 0, 0]));
    let uploads = 0;
    const write = engine._device.queue.writeBuffer.bind(engine._device.queue);
    engine._device.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
        if (buffer === args._buffer || buffer === other._buffer) {
            uploads++;
        }
        write(buffer, offset, data, dataOffset, size);
        canvas.dataset.argumentUploads = String(uploads);
    };
    let bundles = 0;
    const makeBundle = engine._device.createRenderBundleEncoder.bind(engine._device);
    engine._device.createRenderBundleEncoder = (descriptor) => {
        bundles++;
        canvas.dataset.bundleBuilds = String(bundles);
        return makeBundle(descriptor);
    };
    const shader = createComputeShader(engine, {
        computeSource: `
@group(0) @binding(0) var<storage, read_write> args: array<u32>;
@group(0) @binding(1) var<storage, read_write> other: array<u32>;
@group(0) @binding(2) var<uniform> control: vec4u;
@compute @workgroup_size(1) fn main() {
let count = select(select(0u, 3u, control.x == 1u), 6u, control.x == 2u);
args[2] = count; args[3] = 1u; args[4] = select(0u, 3u, control.x == 1u);
args[5] = bitcast<u32>(-1i); args[6] = 0u;
other[3] = count; other[4] = 1u; other[5] = 0u;
other[6] = bitcast<u32>(-1i); other[7] = 0u;
}`,
        bindings: [
            computeStorageBufferBinding("args", { group: 0, binding: 0, access: "read-write" }),
            computeStorageBufferBinding("other", { group: 0, binding: 1, access: "read-write" }),
            computeUniformBufferBinding("control", { group: 0, binding: 2 }),
        ],
    });
    const task = createComputeTask(engine, "indexed-draw-arguments");
    addComputeDispatch(task, createComputeDispatch(shader, createComputeBindingSet(shader, { args, other, control }), { size: { x: 1 } }));
    addTaskAtStart(scene, task);
    const material = createShaderMaterial({
        attributes: ["position"],
        backFaceCulling: false,
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return input.position; }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }`,
    });
    setShaderAttributeFormats(material, { position: "float32x4" });
    const mesh = createMeshFromStorageBuffer(engine, "GPU-counted", {
        storage: vertices,
        indices: new Uint32Array([2, 3, 4, 5, 6, 7]),
        vertexCount: 8,
        arrayStride: 16,
        boundMin: [-1, -1, 0],
        boundMax: [1, 1, 0],
    });
    mesh.material = material;
    setMeshIndexedIndirect(mesh, args, 8);
    addToScene(scene, mesh);
    const publish = (mode: string): void => {
        canvas.dataset.mode = mode;
        canvas.dataset.cpuIndexCount = String(mesh._gpu.indexCount);
        canvas.dataset.drawInfo = JSON.stringify(getMeshIndexedDrawInfo(mesh));
    };
    for (const [id, mode] of [
        ["none", 0],
        ["one", 1],
        ["two", 2],
    ] as const) {
        document.getElementById(id)!.onclick = () => {
            updateUniformBuffer(engine, control, new Uint32Array([mode, 0, 0, 0]));
            publish(id);
        };
    }
    document.getElementById("replace")!.onclick = () => {
        updateUniformBuffer(engine, control, new Uint32Array([1, 0, 0, 0]));
        setMeshIndexedIndirect(mesh, other, 12);
        publish("replace");
    };
    document.getElementById("unbind")!.onclick = () => {
        setMeshIndexedIndirect(mesh, null);
        publish("unbind");
    };
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.gpuErrors = JSON.stringify(errors);
    canvas.dataset.argumentUploads = String(uploads);
    publish("one");
    canvas.dataset.ready = "true";
}

void main().catch((error: unknown) => {
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
