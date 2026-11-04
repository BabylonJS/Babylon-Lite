import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "../parity/parity-fixtures";
import type * as Gpu from "../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type * as Scheduler from "../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scheduler.js";
import type * as Api from "../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type * as Scene from "../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import type * as Decoder from "../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import type * as Camera from "../../../packages/babylon-lite/src/camera/free-camera.js";
import type * as Pbr from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type * as Mock from "../unit/mesh-lod/fixtures/gpu-mock.js";
import type * as Fixture from "../unit/mesh-lod/fixtures/mlod-fixture.js";

const sourceRoot = resolve(__dirname, "..", "..", "..", "packages", "babylon-lite", "src", "mesh-lod");
// /@fs//home/... and /@fs/home/... are distinct browser module identities.
const moduleUrl = (...parts: string[]): string =>
    `/@fs/${resolve(...parts)
        .replaceAll("\\", "/")
        .replace(/^\/+/, "")}`;

test("production MeshLoD WGSL preserves zero and high shared-page demand priorities", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(
        async ({ shader, gpuUrl, schedulerUrl, apiUrl, sceneUrl, decoderUrl, cameraUrl, materialUrl, mockUrl, fixtureUrl }) => {
            const gpu = (await import(gpuUrl)) as typeof Gpu;
            const scheduling = (await import(schedulerUrl)) as typeof Scheduler;
            const api = (await import(apiUrl)) as typeof Api;
            const scene = (await import(sceneUrl)) as typeof Scene;
            const decoder = (await import(decoderUrl)) as typeof Decoder;
            const cameras = (await import(cameraUrl)) as typeof Camera;
            const materials = (await import(materialUrl)) as typeof Pbr;
            const mocks = (await import(mockUrl)) as typeof Mock;
            const fixtures = (await import(fixtureUrl)) as typeof Fixture;
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error("WebGPU adapter unavailable");
            }
            const device = await adapter.requestDevice();
            let scheduler: Scheduler.MeshLoDRequestScheduler | undefined;
            let cpuAsset: Api.MeshLoDAsset | undefined;
            try {
                device.pushErrorScope("validation");
                const module = device.createShaderModule({ code: shader });
                const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
                if (errors.length) {
                    throw new Error(errors.map((message) => message.message).join("\n"));
                }
                const layout = device.createBindGroupLayout({
                    entries: Array.from({ length: 8 }, (_, binding): GPUBindGroupLayoutEntry => ({
                        binding,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: binding === 0 ? "uniform" : binding <= 3 ? "read-only-storage" : "storage" },
                    })),
                });
                const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
                const pipelines = await Promise.all(
                    ["traverse", "evaluateGroups", "selectClusters", "computeDemand", "clampSelectedCount"].map((entryPoint) =>
                        device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } })
                    )
                );
                const center: [number, number, number] = [0, 0, 0];
                const nodeRecords = [0, 1].map((groupId) => ({ center, radius: 1, error: 5, groupId, childOffset: 0, childCount: 0 }));
                const nodes = gpu.packHierarchyNodes(nodeRecords);
                const groupRecords = [0, 1].map((id) => ({
                    center,
                    radius: 1,
                    simplifiedError: id === 0 ? 0 : 5,
                    depth: id,
                    firstCluster: id,
                    clusterCount: 1,
                    firstPageRef: id,
                    pageRefCount: 1,
                    terminal: id === 0,
                    pinned: id === 0,
                    sourceTriangleCount: 1,
                    outputTriangleCount: 1,
                }));
                const groups = gpu.packGroups(groupRecords);
                const clusterRecords = [0, 1].map((id) => ({
                    center,
                    radius: 1,
                    error: 0,
                    groupId: id,
                    refinedGroupId: id === 0 ? 1 : -1,
                    pageId: id,
                    triangleCount: 1,
                    vertexCount: 3,
                    vertexOffset: 0,
                    indexOffset: 0,
                    sourceTriangleCount: 1,
                }));
                const clusters = gpu.packClusters(clusterRecords);
                const refs = gpu.packGroupPageRefs(Uint32Array.from([0, 1]));
                const meta = Uint32Array.from([...nodes, ...groups, ...clusters, ...refs]);
                const instances = new Float32Array(2 * gpu.INSTANCE_WORDS);
                const instancesU32 = new Uint32Array(instances.buffer);
                for (let slot = 0; slot < 2; slot++) {
                    gpu.packInstanceRecord(instances, instancesU32, slot * gpu.INSTANCE_WORDS, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true, slot);
                }
                const pageState = new Uint32Array(2 * gpu.PAGE_STATE_WORDS);
                pageState[0] = gpu.PAGE_FLAG_RESIDENT;
                const params = new Float32Array(64);
                const paramsU32 = new Uint32Array(params.buffer);
                params[27] = 0.1;
                params.set([100, 100, 50, 0], 28);
                params.set([2, Math.fround(1.15), Math.fround(0.85), 0], 32);
                paramsU32.set([1, 2, 2, 2, 1, 2, 2, 2], 36);
                paramsU32.set([0, nodes.length, nodes.length + groups.length, nodes.length + groups.length + clusters.length], 44);
                paramsU32.set([gpu.CONTROL_VISIBLE_GROUP_WORD, gpu.CONTROL_PAGE_DEMAND_OFFSET, 6, 0], 48);
                paramsU32.set([0, device.limits.maxComputeWorkgroupsPerDimension, gpu.meshLoDPageUseOffset(2), gpu.meshLoDPageDemandBitsOffset(2)], 52);
                const controlWords = gpu.meshLoDPageDemandBitsOffset(2) + 1;
                const upload = (data: Uint32Array<ArrayBuffer>, usage: number): GPUBuffer => {
                    const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
                    device.queue.writeBuffer(buffer, 0, data);
                    return buffer;
                };
                const buffers = [
                    upload(paramsU32, GPUBufferUsage.UNIFORM),
                    upload(meta, GPUBufferUsage.STORAGE),
                    upload(pageState, GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(instances.buffer), GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(2), GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(4), GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(9), GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(controlWords), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
                ];
                const bindGroup = device.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
                const staging = device.createBuffer({ size: controlWords * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                const compute = async (errorPixels: number): Promise<Gpu.MeshLoDGpuReadback> => {
                    const groupF32 = new Float32Array(groups.buffer);
                    params[26] = groupF32[gpu.GROUP_WORDS + 3]! + (groupF32[gpu.GROUP_WORDS + 4]! * params[30]!) / errorPixels;
                    device.queue.writeBuffer(buffers[0]!, 0, params);
                    const encoder = device.createCommandEncoder();
                    for (const index of [5, 6, 7]) {
                        encoder.clearBuffer(buffers[index]!);
                    }
                    const pass = encoder.beginComputePass();
                    pass.setBindGroup(0, bindGroup);
                    for (const pipeline of pipelines) {
                        pass.setPipeline(pipeline);
                        pass.dispatchWorkgroups(1);
                    }
                    pass.end();
                    encoder.copyBufferToBuffer(buffers[7]!, 0, staging, 0, staging.size);
                    device.queue.submit([encoder.finish()]);
                    await staging.mapAsync(GPUMapMode.READ);
                    const control = new Uint32Array(staging.getMappedRange()).slice();
                    staging.unmap();
                    return gpu.decodeMeshLoDGpuReadback(control, 2, () => 65536);
                };
                let starts = 0;
                let aborts = 0;
                const failures: string[] = [];
                scheduler = scheduling.createMeshLoDRequestScheduler({
                    maxConcurrentRequests: 1,
                    retryCount: 0,
                    retryDelaysMs: [],
                    obsoleteRequestGraceFrames: 2,
                    callbacks: {
                        fetchPage: (_pageId, signal) =>
                            new Promise<Uint8Array>((_resolve, reject) => {
                                starts++;
                                signal.addEventListener("abort", () => {
                                    aborts++;
                                    reject(new Error("cancelled"));
                                });
                            }),
                        onPageReceived: () => {
                            throw new Error("pending request unexpectedly completed");
                        },
                        onPageFailed: (_pageId, error) => failures.push(error.message),
                        currentGeneration: () => 1,
                        isPaused: () => false,
                    },
                });
                const initial = await compute(2.4);
                scheduling.submitMeshLoDDemand(scheduler, initial.demand, 1);
                const band: Gpu.MeshLoDGpuReadback[] = [];
                for (let frame = 2; frame <= 8; frame++) {
                    const readback = await compute(1.9);
                    band.push(readback);
                    scheduling.submitMeshLoDDemand(scheduler, readback.demand, frame);
                }
                const pendingInBand = scheduler.requests.get(1)?.state === "fetching";
                const abortsInBand = aborts;
                const lastDemandFrame = scheduler.requests.get(1)?.lastDemandFrame;
                const withdrawn = await compute(1.6);
                for (let frame = 9; frame <= 12; frame++) {
                    scheduling.submitMeshLoDDemand(scheduler, withdrawn.demand, frame);
                }
                const groupF32 = new Float32Array(groups.buffer);
                groupF32[gpu.GROUP_WORDS + 3] = 1024;
                groupF32[gpu.GROUP_WORDS + 4] = 18;
                params.set([1024, 1024, 512, 0], 28);
                paramsU32[36] = 2;
                const { engine } = mocks.createMockEngine();
                const fillDecoder = mocks.createFillDecoder();
                decoder._setMeshLoDPageDecoder(fillDecoder.decoder);
                const loaded = await api.loadMeshLoD(engine, fixtures.buildMinimalContainer().bytes.buffer as ArrayBuffer, {
                    selectionMode: "cpu",
                    cacheCapacityBytes: 2 * 65536,
                    cacheBudgetBytes: 2 * 65536,
                });
                const coarseRecord = loaded._runtime.pageRecords[0]!;
                const coarsePage = loaded._runtime.gpu.pages[0]!;
                cpuAsset = {
                    ...loaded,
                    _runtime: {
                        ...loaded._runtime,
                        header: { ...loaded._runtime.header, levelCount: 2 },
                        groups: groupRecords,
                        clusters: clusterRecords,
                        hierarchyNodes: nodeRecords,
                        groupPageRefs: Uint32Array.from([0, 1]),
                        pageRecords: [
                            { ...coarseRecord, storedBytes: 65536 },
                            { ...coarseRecord, storedBytes: 65536, pinned: false, coarse: false },
                        ],
                        gpu: {
                            ...loaded._runtime.gpu,
                            pages: [coarsePage, { ...coarsePage, id: 1, state: "unrequested", arenaOffset: -1, arenaBytes: 0, indices: null }],
                        },
                    },
                };
                const batch: Scene.MeshLoDSceneBatch = {
                    asset: cpuAsset,
                    material: materials.createPbrMaterial({ doubleSided: true }),
                    instances: [],
                };
                batch.instances.push(api.createMeshLoDInstance(cpuAsset, batch.material), api.createMeshLoDInstance(cpuAsset, batch.material));
                const history = new Map<number, Scene.MeshLoDCpuInstanceHistory>();
                const producer = {};
                const shared = [];
                for (const { errorPixels, sourceError } of [
                    { errorPixels: 18, sourceError: 18 },
                    { errorPixels: 36, sourceError: 18 },
                    { errorPixels: 4e32, sourceError: 4e32 },
                    { errorPixels: 1.9, sourceError: 18 },
                ]) {
                    groupF32[gpu.GROUP_WORDS + 4] = sourceError;
                    device.queue.writeBuffer(buffers[1]!, nodes.byteLength, groups);
                    const readback = await compute(errorPixels);
                    groupRecords[1] = { ...groupRecords[1]!, radius: groupF32[gpu.GROUP_WORDS + 3]!, simplifiedError: groupF32[gpu.GROUP_WORDS + 4]! };
                    const camera = cameras.createFreeCamera({ x: 0, y: 0, z: params[26]! }, { x: 0, y: 0, z: 0 });
                    camera.fov = Math.PI / 2;
                    camera.nearPlane = 0.1;
                    const selections = scene.selectMeshLoDBatch(batch, { targetWidth: 1024, targetHeight: 1024, _camera: camera }, history);
                    scene.driveMeshLoDStreaming(batch, selections, producer);
                    const cpuDemand = [...cpuAsset._runtime._frameSnapshots.get(producer)!.demand];
                    engine._finishOptionalFrame?.(false);
                    const retirements = engine._retirements;
                    engine._retirements = null;
                    retirements?.forEach((retire) => retire());
                    const priorState = new Uint32Array(2);
                    if (errorPixels < 2) {
                        priorState.fill(2);
                    }
                    const model = gpu.runMeshLoDGpuSelection({
                        nodes,
                        groups,
                        clusters,
                        groupPageRefs: refs,
                        pageState,
                        pageStoredBytes: [65536, 65536],
                        instances,
                        instancesU32,
                        priorState,
                        instanceCount: 2,
                        groupCount: 2,
                        clusterCount: 2,
                        nodeCount: 2,
                        pageCount: 2,
                        wordsPerInstance: 1,
                        params: {
                            cameraPos: [0, 0, params[26]!],
                            verticalFov: 1,
                            perspectivePixelScale: 512,
                            near: 0.1,
                            targetWidth: 1024,
                            targetHeight: 1024,
                            frustumPlanes: [],
                            screenSpaceError: 2,
                            lodHysteresis: 0.15,
                            levelCount: 2,
                        },
                    });
                    shared.push({ readback, cpuDemand, model: model.desiredPages });
                }
                const validation = await device.popErrorScope();
                if (validation) {
                    throw new Error(validation.message);
                }
                return { initial, band, pendingInBand, abortsInBand, lastDemandFrame, starts, withdrawn, aborts, failures, shared, decoderModes: fillDecoder.modes };
            } finally {
                if (cpuAsset) {
                    api.disposeMeshLoDAsset(cpuAsset);
                }
                decoder._setMeshLoDPageDecoder(null);
                if (scheduler) {
                    scheduling.disposeMeshLoDRequestScheduler(scheduler);
                }
                device.destroy();
            }
        },
        {
            shader: readFileSync(resolve(sourceRoot, "mesh-lod-selection.wgsl"), "utf8"),
            gpuUrl: moduleUrl(sourceRoot, "mesh-lod-selection-gpu.ts"),
            schedulerUrl: moduleUrl(sourceRoot, "mesh-lod-scheduler.ts"),
            apiUrl: moduleUrl(sourceRoot, "mesh-lod.ts"),
            sceneUrl: moduleUrl(sourceRoot, "mesh-lod-scene.ts"),
            decoderUrl: moduleUrl(sourceRoot, "mesh-lod-page-decoder.ts"),
            cameraUrl: moduleUrl(sourceRoot, "..", "camera", "free-camera.ts"),
            materialUrl: moduleUrl(sourceRoot, "..", "material", "pbr", "pbr-material.ts"),
            mockUrl: moduleUrl(__dirname, "..", "unit", "mesh-lod", "fixtures", "gpu-mock.ts"),
            fixtureUrl: moduleUrl(__dirname, "..", "unit", "mesh-lod", "fixtures", "mlod-fixture.ts"),
        }
    );
    expect(result.initial.demand).toHaveLength(1);
    expect(result.initial.demand[0]!.priority).toBeGreaterThan(0);
    for (const readback of result.band) {
        expect(readback.demand).toEqual([{ pageId: 1, priority: 0 }]);
        expect(readback.maximumUnmetErrorPixels).toBeCloseTo(1.9, 5);
        expect(readback.selectedClusterCount).toBe(1);
        expect(readback.fallbackGroupCount).toBe(1);
    }
    expect(result.pendingInBand).toBe(true);
    expect(result.abortsInBand).toBe(0);
    expect(result.lastDemandFrame).toBe(8);
    expect(result.starts).toBe(1);
    expect(result.withdrawn.demand).toEqual([]);
    expect(result.aborts).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.decoderModes).toEqual(["ATTRIBUTES", "TRIANGLES"]);
    expect(result.shared.map(({ readback }) => readback.demand[0]?.priority)).toEqual([256, 544, 3.4028234663852886e38 / 65536, 0]);
    for (const { readback, cpuDemand, model } of result.shared) {
        expect(readback.demand).toEqual(model);
        expect(readback.demand).toEqual(cpuDemand);
        expect(readback.selectedClusterCount).toBe(2);
        expect(readback.fallbackGroupCount).toBe(2);
    }
});
