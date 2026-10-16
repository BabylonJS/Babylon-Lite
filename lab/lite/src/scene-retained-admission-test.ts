import {
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createPlane,
    createStandardMaterial,
    addToScene,
    registerScene,
    startEngine,
    stopEngine,
    captureScreenshot,
    retainMeshResources,
    releaseMeshResources,
    detachMeshFromScene,
    waitForGpuResourceRetirements,
    createGpuPicker,
    pickAsync,
    pickWithRay,
    disposePicker,
    disposeScene,
    disposeEngine,
    disposeMeshGpu,
    onEngineGpuError,
    type Mesh,
} from "babylon-lite";

export interface HierarchyResults {
    ready: boolean;
    error: string | null;
    order: string[];
    freshOrder: string[];
    pixels: number[][];
    detachedHit: boolean;
    restoredHit: string | null;
    freshHit: string | null;
    cpuRestored: boolean;
    sameGeometry: boolean;
    geometryAllocations: number[];
    childDestroys: number;
    gpuErrors: string[];
}
const result: HierarchyResults = {
    ready: false,
    error: null,
    order: [],
    freshOrder: [],
    pixels: [],
    detachedHit: true,
    restoredHit: null,
    freshHit: null,
    cpuRestored: false,
    sameGeometry: false,
    geometryAllocations: [],
    childDestroys: 0,
    gpuErrors: [],
};
Object.assign(window, { retainedHierarchyTest: result });

async function run(): Promise<void> {
    const canvas = document.querySelector("canvas");
    if (!canvas) {
        throw new Error("Missing test canvas");
    }
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    onEngineGpuError(engine, (error) => result.gpuErrors.push(error.message));
    let geometryAllocations = 0;
    const createBuffer = engine._device.createBuffer.bind(engine._device);
    engine._device.createBuffer = (descriptor) => {
        if (descriptor.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) {
            geometryAllocations++;
        }
        return createBuffer(descriptor);
    };
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    const card = (name: string, color: [number, number, number]): Mesh => {
        const mesh = createPlane(engine, { size: 2 });
        mesh.name = name;
        const material = createStandardMaterial();
        material.disableLighting = true;
        material.emissiveColor = color;
        material.alpha = 0.5;
        material.backFaceCulling = false;
        mesh.material = material;
        return mesh;
    };
    const parent = card("parent", [1, 1, 1]);
    const child = card("child", [1, 0, 0]);
    const peer = card("peer", [0, 0, 1]);
    parent.position.x = 3;
    child.position.x = -3;
    parent.children.push(child);
    addToScene(scene, parent);
    addToScene(scene, peer);
    const lease = retainMeshResources(engine, child);
    const gpu = child._gpu;
    for (const buffer of [gpu.positionBuffer, gpu.normalBuffer, gpu.uvBuffer, gpu.indexBuffer]) {
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => {
            result.childDestroys++;
            destroy();
        };
    }
    await registerScene(scene);
    await startEngine(engine);
    const pixel = async (): Promise<number[]> => {
        const shot = await captureScreenshot(engine);
        const offset = (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
        return Array.from(shot.data.slice(offset, offset + 4));
    };
    const picker = createGpuPicker(scene);
    result.geometryAllocations.push(geometryAllocations);
    detachMeshFromScene(scene, child);
    await waitForGpuResourceRetirements(engine);
    result.detachedHit = (await pickAsync(picker, 64, 64, { filter: (mesh) => mesh === child })).hit;
    addToScene(scene, parent);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    result.order = scene.meshes.map((mesh) => mesh.name);
    result.pixels.push(await pixel());
    result.restoredHit = (await pickAsync(picker, 64, 64, { filter: (mesh) => mesh === child })).pickedMesh?.name ?? null;
    result.cpuRestored = pickWithRay(scene, { origin: [0, 0, -5], direction: [0, 0, 1], length: 10 }, { predicate: (mesh) => mesh === child }).hit;
    result.sameGeometry = child._gpu === gpu;
    result.geometryAllocations.push(geometryAllocations);
    const fresh = card("fresh", [0, 1, 0]);
    fresh.position.x = -3;
    parent.children.push(fresh);
    addToScene(scene, parent);
    addToScene(scene, parent);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    result.freshOrder = scene.meshes.map((mesh) => mesh.name);
    result.pixels.push(await pixel());
    result.freshHit = (await pickAsync(picker, 64, 64, { filter: (mesh) => mesh === fresh })).pickedMesh?.name ?? null;
    disposePicker(picker);
    stopEngine(engine);
    disposeScene(scene);
    releaseMeshResources(lease);
    await waitForGpuResourceRetirements(engine);
    if (!fresh._disposed) {
        disposeMeshGpu(fresh);
    }
    const reference = createSceneContext(engine);
    reference.clearColor = scene.clearColor;
    reference.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    for (const [name, color] of [
        ["peer", [0, 0, 1]],
        ["child", [1, 0, 0]],
        ["fresh", [0, 1, 0]],
    ] as const) {
        addToScene(reference, card(name, [...color]));
    }
    await registerScene(reference);
    await startEngine(engine);
    result.pixels.push(await pixel());
    stopEngine(engine);
    disposeScene(reference);
    await waitForGpuResourceRetirements(engine);
    disposeEngine(engine);
    result.ready = true;
}
void run().catch((error: unknown) => {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(error);
});
