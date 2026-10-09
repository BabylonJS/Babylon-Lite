import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "../parity/parity-fixtures";
import type * as Gpu from "../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type * as Scheduler from "../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scheduler.js";

const sourceRoot = resolve(__dirname, "..", "..", "..", "packages", "babylon-lite", "src", "mesh-lod");
const moduleUrl = (name: string): string => `/@fs/${resolve(sourceRoot, name).replaceAll("\\", "/")}`;

test("production MeshLoD WGSL retains zero-priority demand while a fine-page request is pending", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(
        async ({ shader, gpuUrl, schedulerUrl }) => {
            const gpu = (await import(gpuUrl)) as typeof Gpu;
            const scheduling = (await import(schedulerUrl)) as typeof Scheduler;
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error("WebGPU adapter unavailable");
            }
            const device = await adapter.requestDevice();
            let scheduler: Scheduler.MeshLoDRequestScheduler | undefined;
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
                const nodes = gpu.packHierarchyNodes([0, 1].map((groupId) => ({ center, radius: 1, error: 5, groupId, childOffset: 0, childCount: 0 })));
                const groups = gpu.packGroups(
                    [0, 1].map((id) => ({
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
                    }))
                );
                const clusters = gpu.packClusters(
                    [0, 1].map((id) => ({
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
                    }))
                );
                const refs = gpu.packGroupPageRefs(Uint32Array.from([0, 1]));
                const meta = Uint32Array.from([...nodes, ...groups, ...clusters, ...refs]);
                const instances = new Float32Array(gpu.INSTANCE_WORDS);
                gpu.packInstanceRecord(instances, new Uint32Array(instances.buffer), 0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true, 0);
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
                    upload(new Uint32Array(1), GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(2), GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(5), GPUBufferUsage.STORAGE),
                    upload(new Uint32Array(controlWords), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
                ];
                const bindGroup = device.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
                const staging = device.createBuffer({ size: controlWords * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                const compute = async (errorPixels: number): Promise<Gpu.MeshLoDGpuReadback> => {
                    params[26] = 1 + 250 / errorPixels;
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
                const validation = await device.popErrorScope();
                if (validation) {
                    throw new Error(validation.message);
                }
                return { initial, band, pendingInBand, abortsInBand, lastDemandFrame, starts, withdrawn, aborts, failures };
            } finally {
                if (scheduler) {
                    scheduling.disposeMeshLoDRequestScheduler(scheduler);
                }
                device.destroy();
            }
        },
        {
            shader: readFileSync(resolve(sourceRoot, "mesh-lod-selection.wgsl"), "utf8"),
            gpuUrl: moduleUrl("mesh-lod-selection-gpu.ts"),
            schedulerUrl: moduleUrl("mesh-lod-scheduler.ts"),
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
});
