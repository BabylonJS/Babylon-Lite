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
    removeFromScene,
    waitForGpuResourceRetirements,
    createGpuPicker,
    pickAsync,
    pickWithRay,
    disposePicker,
    disposeScene,
    disposeEngine,
    onEngineGpuError,
    createTransformNode,
    updateMeshGeometryCapacity,
    enableDeviceLostSceneRecovery,
    forceWebGpuDeviceLossForTesting,
    type DeviceLostRecoveryHandle,
    createMeshFromData,
    createShaderMaterial,
    wgsl,
    type Mesh,
} from "babylon-lite";

export interface RetentionResults {
    ready: boolean;
    error: string | null;
    gpuErrors: string[];
    pixels: Record<string, number[]>;
    geometryAllocations: number[];
    totalAllocations: number[];
    retainedDestroys: number;
    finalDestroys: number;
    cycleCount: number;
    cpuDetachedHit: boolean;
    gpuDetachedHit: boolean;
    pendingGpuHit: boolean;
    queuedGpuHit: boolean;
    gpuRestoredName: string | null;
    legacyReaddRejected: boolean;
    finalReaddRejected: boolean;
    identityPreserved: boolean;
    uniqueDetachedUpdate: boolean;
    maxGroupOutputs: number;
    recoveredDetached: boolean;
    recoveredPickName: string | null;
    detachedBoundsUpdated: boolean;
    detachedMaterialSwap: boolean;
}

const results: RetentionResults = {
    ready: false,
    error: null,
    gpuErrors: [],
    pixels: {},
    geometryAllocations: [],
    totalAllocations: [],
    retainedDestroys: 0,
    finalDestroys: 0,
    cycleCount: 0,
    cpuDetachedHit: true,
    gpuDetachedHit: true,
    pendingGpuHit: true,
    queuedGpuHit: true,
    gpuRestoredName: null,
    legacyReaddRejected: false,
    finalReaddRejected: false,
    identityPreserved: false,
    uniqueDetachedUpdate: false,
    maxGroupOutputs: 0,
    recoveredDetached: false,
    recoveredPickName: null,
    detachedBoundsUpdated: false,
    detachedMaterialSwap: false,
};
Object.assign(window, { meshRetentionTest: results });

async function run(): Promise<void> {
    const canvas = document.querySelector("canvas");
    if (!canvas) {
        throw new Error("Missing test canvas");
    }
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    let recovery!: DeviceLostRecoveryHandle;
    const recovered = new Promise<void>((resolve, reject) => {
        recovery = enableDeviceLostSceneRecovery(engine, {
            onRecovered: resolve,
            onRecoveryFailed: reject,
        });
    });
    onEngineGpuError(engine, (error) => results.gpuErrors.push(error.message));
    let geometryAllocations = 0;
    let totalAllocations = 0;
    let geometryDestroys = 0;
    let onPickReadback: (() => void) | undefined;
    // Native allocation instrumentation is local to this test's own device.
    const createBuffer = engine._device.createBuffer.bind(engine._device);
    engine._device.createBuffer = (descriptor) => {
        totalAllocations++;
        const buffer = createBuffer(descriptor);
        if (descriptor.label === "pick-color-staging") {
            const mapAsync = buffer.mapAsync.bind(buffer);
            buffer.mapAsync = (mode, offset, size) => {
                const mapping = mapAsync(mode, offset, size);
                const mutate = onPickReadback;
                onPickReadback = undefined;
                mutate?.();
                return mapping;
            };
        }
        if (descriptor.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) {
            geometryAllocations++;
            const destroy = buffer.destroy.bind(buffer);
            buffer.destroy = () => {
                geometryDestroys++;
                destroy();
            };
        }
        return buffer;
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
        material.diffuseColor = [1, 1, 1];
        material.alpha = 0.5;
        material.backFaceCulling = false;
        mesh.material = material;
        return mesh;
    };
    const red = card("red", [1, 0, 0]);
    const blue = card("blue", [0, 0, 1]);
    const shaderMaterial = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position.xy, 0.5, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(0, 1, 0, 1); }`,
        attributes: ["position"],
        backFaceCulling: false,
    });
    const shaderCard = (name: string, left: number, right: number): Mesh => {
        const mesh = createMeshFromData(
            engine,
            name,
            new Float32Array([left, -0.95, 0, right, -0.95, 0, right, -0.65, 0, left, -0.65, 0]),
            new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            new Uint32Array([0, 1, 2, 0, 2, 3])
        );
        mesh.material = shaderMaterial;
        return mesh;
    };
    const shaderLeft = shaderCard("shader-left", -0.95, -0.65);
    const shaderRight = shaderCard("shader-right", 0.65, 0.95);
    red.id = "retained-card";
    red.metadata = { retained: true };
    const parent = createTransformNode("parent");
    red.parent = parent;
    addToScene(scene, red);
    addToScene(scene, blue);
    addToScene(scene, shaderLeft);
    addToScene(scene, shaderRight);
    const lease = retainMeshResources(engine, red);
    const shaderLease = retainMeshResources(engine, shaderLeft);
    const originalGpu = red._gpu;
    await registerScene(scene);
    await startEngine(engine);
    const pixel = async (name: string, x?: number, y?: number): Promise<void> => {
        const shot = await captureScreenshot(engine);
        const offset = ((y ?? Math.floor(shot.height / 2)) * shot.width + (x ?? Math.floor(shot.width / 2))) * 4;
        results.pixels[name] = Array.from(shot.data.slice(offset, offset + 4));
    };
    await pixel("initial");
    await pixel("shaderInitial", 10, 118);
    const picker = createGpuPicker(scene);
    await pickAsync(picker, 64, 64);
    onPickReadback = () => detachMeshFromScene(scene, red);
    results.pendingGpuHit = (await pickAsync(picker, 64, 64, { filter: (mesh) => mesh === red })).hit;
    detachMeshFromScene(scene, red);
    detachMeshFromScene(scene, shaderLeft);
    const queued = [pickAsync(picker, 64, 64, { filter: (mesh) => mesh === red }), pickAsync(picker, 64, 64, { filter: (mesh) => mesh === red })];
    results.queuedGpuHit = (await Promise.all(queued)).some((info) => info.hit);
    await waitForGpuResourceRetirements(engine);
    await pixel("detached");
    await pixel("shaderDetached", 10, 118);
    results.cpuDetachedHit = pickWithRay(scene, { origin: [0, 0, -5], direction: [0, 0, 1], length: 10 }, { predicate: (mesh) => mesh === red }).hit;
    results.gpuDetachedHit = (await pickAsync(picker, 64, 64, { filter: (mesh) => mesh === red })).hit;
    const originalMaterial = red.material;
    const swappedMaterial = createStandardMaterial();
    swappedMaterial.disableLighting = true;
    swappedMaterial.emissiveColor = [0, 1, 0];
    swappedMaterial.alpha = 0.5;
    swappedMaterial.backFaceCulling = false;
    red.material = swappedMaterial;
    addToScene(scene, red);
    addToScene(scene, shaderLeft);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await pixel("swapped");
    await pixel("shaderReinserted", 10, 118);
    results.detachedMaterialSwap = red.material === swappedMaterial;
    detachMeshFromScene(scene, red);
    detachMeshFromScene(scene, shaderLeft);
    red.material = originalMaterial;
    addToScene(scene, red);
    addToScene(scene, shaderLeft);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await pixel("reinserted");
    results.gpuRestoredName = (await pickAsync(picker, 64, 64, { filter: (mesh) => mesh === red })).pickedMesh?.name ?? null;
    results.identityPreserved = red._gpu === originalGpu && red.parent === parent && red.id === "retained-card" && red.metadata?.retained === true;
    results.geometryAllocations.push(geometryAllocations);
    results.totalAllocations.push(totalAllocations);
    const destroysBeforeCycles = geometryDestroys;
    for (let i = 0; i < 1000; i++) {
        detachMeshFromScene(scene, red);
        detachMeshFromScene(scene, shaderLeft);
        await waitForGpuResourceRetirements(engine);
        addToScene(scene, red);
        addToScene(scene, shaderLeft);
        // Submit the public scene render pipeline on every complete activation.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        results.cycleCount++;
        for (const group of scene._groups.values()) {
            results.maxGroupOutputs = Math.max(results.maxGroupOutputs, group.o?.length ?? 0);
        }
    }
    results.geometryAllocations.push(geometryAllocations);
    results.totalAllocations.push(totalAllocations);
    results.retainedDestroys = geometryDestroys - destroysBeforeCycles;
    await pixel("cycled");
    await pixel("shaderCycled", 10, 118);
    detachMeshFromScene(scene, red);
    const fresh = card("fresh-red", [1, 0, 0]);
    addToScene(scene, fresh);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await pixel("fresh");
    removeFromScene(scene, fresh);
    await waitForGpuResourceRetirements(engine);
    try {
        addToScene(scene, fresh);
    } catch (error) {
        results.legacyReaddRejected = error instanceof Error && error.message.includes("disposed");
    }
    const positions = red._cpuPositions?.slice();
    const normals = red._cpuNormals;
    const indices = red._cpuIndices;
    if (!positions || !normals || !indices) {
        throw new Error("Plane must retain public-factory geometry for update validation");
    }
    for (let i = 0; i < positions.length; i++) {
        positions[i] = positions[i]! * 0.5;
    }
    const update = updateMeshGeometryCapacity(engine, red, positions, normals, indices, red._cpuUvs);
    results.uniqueDetachedUpdate = update.stable && red._gpu === originalGpu;
    results.detachedBoundsUpdated = red.boundMin?.[0] === -0.5 && red.boundMax?.[0] === 0.5;
    forceWebGpuDeviceLossForTesting(engine);
    await recovered;
    results.recoveredDetached = red._gpu !== originalGpu && !scene.meshes.includes(red);
    addToScene(scene, red);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    results.recoveredPickName = (await pickAsync(picker, 64, 64, { filter: (mesh) => mesh === red })).pickedMesh?.name ?? null;
    await pixel("recovered");
    detachMeshFromScene(scene, red);
    for (const buffer of [red._gpu.positionBuffer, red._gpu.normalBuffer, red._gpu.uvBuffer, red._gpu.indexBuffer]) {
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => {
            geometryDestroys++;
            destroy();
        };
    }
    const beforeRelease = geometryDestroys;
    releaseMeshResources(lease);
    releaseMeshResources(lease);
    await waitForGpuResourceRetirements(engine);
    results.finalDestroys = geometryDestroys - beforeRelease;
    try {
        addToScene(scene, red);
    } catch (error) {
        results.finalReaddRejected = error instanceof Error && error.message.includes("disposed");
    }
    disposePicker(picker);
    releaseMeshResources(shaderLease);
    stopEngine(engine);
    disposeScene(scene);
    await waitForGpuResourceRetirements(engine);
    recovery.disable();
    disposeEngine(engine);
    results.ready = true;
    canvas.dataset.ready = "true";
}

void run().catch((error: unknown) => {
    results.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(error);
});
