/** MeshLoD CPU/GPU render equivalence (Task 5.4) — REQ-RENDER-2, REQ-RENDER-3.
 *
 *  Node-hosted checks against a mock device that the material-owned render path is
 *  batch-scaled, not meshlet-scaled, and that GPU selection over the REAL statue
 *  hierarchy (312 groups / 2491 clusters / 363 nodes / 12 levels) picks the exact same
 *  clusters — hence the same expanded geometry — as the CPU oracle. Exactly one
 *  `drawIndirect` is issued per exact asset+material+target key regardless of selected
 *  meshlet or instance count. Real WebGPU confirms the rendered pixels are identical to
 *  the CPU reference (MAD 0.0), recorded on the Task 5.3 board entry; goldens unchanged. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMeshLoD, createMeshLoDInstance, setMeshLoDSelectionMode, setMeshLoDDebugView } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { selectMeshLoDCpu } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
import {
    INSTANCE_WORDS,
    PAGE_FLAG_RESIDENT,
    PAGE_STATE_WORDS,
    buildPageStateData,
    packClusters,
    packGroupPageRefs,
    packGroups,
    packHierarchyNodes,
    packInstanceRecord,
    runMeshLoDGpuSelection,
    runMeshLoDGpuExpansion,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { MeshLoDAssetRuntime } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import type { DrawUpdateBatch } from "../../../../packages/babylon-lite/src/render/renderable.js";
import { createXrCamera, updateXrCameraForView } from "../../../../packages/babylon-lite/src/xr/xr-camera.js";
import { getProjectionMatrix } from "../../../../packages/babylon-lite/src/camera/camera.js";
import { meshLoDDebugModeCode } from "../../../../packages/babylon-lite/src/material/pbr/pbr-mesh-lod-debug.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";
import { AcesToneMapping } from "../../../../packages/babylon-lite/src/material/pbr/pbr-aces-wgsl.js";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { setPbrGammaAlbedo } from "../../../../packages/babylon-lite/src/material/pbr/set-gamma-albedo.js";
import { markMaterialUboDirty } from "../../../../packages/babylon-lite/src/material/material-dirty.js";
import { createSolidTexture2D } from "../../../../packages/babylon-lite/src/texture/solid-texture.js";
import { cloneTexture2D } from "../../../../packages/babylon-lite/src/texture/texture-2d.js";
import { createRenderTarget } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { _createAutomaticRenderTask } from "../../../../packages/babylon-lite/src/frame-graph/render-task-base.js";
import { flushGpuResourceRetirements, waitForGpuResourceRetirements } from "../../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
const statueSource = (): ArrayBuffer => new Uint8Array(readFileSync(STATUE)).slice().buffer as ArrayBuffer;

function fakeScene(engine: EngineContext): SceneContext {
    return { _deferredBuilders: [], _renderables: [], _disposables: [], surface: { engine } } as unknown as SceneContext;
}

function fakeCamera(): Camera {
    return {
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 100,
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]),
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
        _viewVer: -1,
        _projVer: -1,
        _projAspect: -1,
        _vpVer: -1,
        _vpAspect: -1,
        _useFloatingOrigin: false,
    } as unknown as Camera;
}

const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };
const CONTEXT = { targetWidth: 800, targetHeight: 600, _camera: fakeCamera() };

let engine: EngineContext;

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
    engine = createMockEngine().engine;
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

async function build(asset: MeshLoDAsset, material: PbrMaterialProps, instanceCount: number, scene = fakeScene(engine)): Promise<SceneContext> {
    for (let i = 0; i < instanceCount; i++) {
        const instance = createMeshLoDInstance(asset, material);
        instance.position.set(i * 2, 0, 0);
        addMeshLoDInstanceToScene(scene, instance);
    }
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    return scene;
}

function flush(binding: { update?: (c: typeof CONTEXT) => void; _updateBatches?: readonly DrawUpdateBatch[] }): void {
    const batch = binding._updateBatches?.[0];
    batch?.reset();
    binding.update!(CONTEXT);
    batch?.flush(engine);
}

/** Run the GPU selection model over a loaded runtime's real packed hierarchy. */
function gpuSelectStatue(runtime: MeshLoDAssetRuntime): number[] {
    const resident = new Set<number>();
    runtime.gpu.pages.forEach((p, id) => {
        if (p.state === "gpu-resident" && p.arenaOffset >= 0) {
            resident.add(id);
        }
    });
    const pageState = new Uint32Array(runtime.gpu.pages.length * PAGE_STATE_WORDS);
    resident.forEach((id) => (pageState[id * PAGE_STATE_WORDS] = PAGE_FLAG_RESIDENT));
    const wordsPerInstance = Math.max(Math.ceil(runtime.groups.length / 32), 1);
    const instances = new Float32Array(INSTANCE_WORDS);
    const instancesU32 = new Uint32Array(instances.buffer);
    packInstanceRecord(instances, instancesU32, 0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true, 0);
    const model = runMeshLoDGpuSelection({
        nodes: packHierarchyNodes(runtime.hierarchyNodes),
        groups: packGroups(runtime.groups),
        clusters: packClusters(runtime.clusters),
        groupPageRefs: packGroupPageRefs(runtime.groupPageRefs),
        pageState,
        pageStoredBytes: runtime.pageRecords.map((r) => r.storedBytes),
        instances,
        instancesU32,
        priorState: new Uint32Array(wordsPerInstance),
        instanceCount: 1,
        nodeCount: runtime.hierarchyNodes.length,
        groupCount: runtime.groups.length,
        clusterCount: runtime.clusters.length,
        pageCount: runtime.gpu.pages.length,
        wordsPerInstance,
        params: {
            cameraPos: [0, 0, 5],
            verticalFov: 1.0,
            near: 0.1,
            targetWidth: 1000,
            targetHeight: 1000,
            frustumPlanes: [],
            screenSpaceError: runtime.settings.screenSpaceError,
            lodHysteresis: runtime.settings.lodHysteresis,
            levelCount: runtime.header.levelCount,
        },
    });
    return [...new Set(model.selected.map((p) => p.clusterId))].sort((a, b) => a - b);
}

function cpuSelectStatue(runtime: MeshLoDAssetRuntime): number[] {
    const result = selectMeshLoDCpu({
        groups: runtime.groups,
        clusters: runtime.clusters,
        nodes: runtime.hierarchyNodes,
        pageRecords: runtime.pageRecords,
        groupPageRefs: runtime.groupPageRefs,
        levelCount: runtime.header.levelCount,
        worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        camera: { position: [0, 0, 5], verticalFov: 1.0, near: 0.1, targetWidth: 1000, targetHeight: 1000 },
        frustumPlanes: [],
        screenSpaceError: runtime.settings.screenSpaceError,
        lodHysteresis: runtime.settings.lodHysteresis,
        isPageResident: (id) => runtime.gpu.pages[id]?.state === "gpu-resident",
        wasFineRequired: new Uint8Array(runtime.groups.length),
    });
    return Array.from(result.selectedClusterIds);
}

describe("MeshLoD render equivalence — GPU selection over the real statue hierarchy", () => {
    it("GPU model selects the same clusters as the CPU oracle", async () => {
        const asset = await loadMeshLoD(engine, statueSource());
        const runtime = asset._runtime;
        const gpu = gpuSelectStatue(runtime);
        const cpu = cpuSelectStatue(runtime);
        expect(gpu).toEqual(cpu);
        expect(gpu.length).toBeGreaterThan(0); // the coarse terminal cut

        // The selected clusters expand to the same triangle count the CPU render reports.
        const cpuTris = gpu.reduce((sum, c) => sum + runtime.clusters[c]!.triangleCount, 0);
        const cpuScene = await build(await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" }), {} as PbrMaterialProps, 1);
        cpuScene._renderables[0]!.bind(engine, SIG).update!(CONTEXT);
        expect(cpuScene._meshLoDRegistry!.batches[0]!.asset.diagnostics.renderedTriangleCount).toBe(cpuTris);
    });
});

describe("MeshLoD render equivalence — one indirect draw per batch key", () => {
    it("rejects gamma-albedo opt-in introduced after scene registration", async () => {
        const asset = await loadMeshLoD(engine, statueSource());
        const material = createPbrMaterial();
        const scene = fakeScene(engine);
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        setPbrGammaAlbedo(material);
        await expect(scene._deferredBuilders[0]!()).rejects.toMatchObject({ code: "MLOD_UNSUPPORTED_MATERIAL", actual: "gamma-albedo decoding" });
    });

    it.each(["cpu", "gpu"] as const)("refreshes the shared dirty material UBO and preserves debug mode (%s)", async (selectionMode) => {
        const mock = createMockEngine();
        engine = mock.engine;
        const writeBuffer = vi.spyOn(mock.device.queue, "writeBuffer");
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode });
        const material = createPbrMaterial();
        const scene = await build(asset, material, 1);
        const bindings = [scene._renderables[0]!.bind(engine, { ...SIG }), scene._renderables[0]!.bind(engine, { ...SIG })];
        setMeshLoDDebugView(asset, "lod-depth");
        bindings.forEach(flush);
        const pass = createMockRenderPass();
        for (const binding of bindings) {
            expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        }
        const ubo = mock.device.buffers.find((buffer) => buffer.label === "mesh-lod-material")!;
        expect(mock.device.buffers.filter((buffer) => buffer.label === "mesh-lod-material")).toHaveLength(1);
        const initialWrites = mock.device.writes.filter((write) => write.buffer === ubo && write.byteLength === 80).length;
        material.baseColorFactor = [0.2, 0.3, 0.4, 1];
        material.roughnessFactor = 0.15;
        material.directIntensity = 0.7;
        material._emissiveColor = [0.8, 0.6, 0.4];
        markMaterialUboDirty(material);
        bindings.forEach(flush);
        const values = new Float32Array(ubo.data.buffer);
        expect(values[0]).toBeCloseTo(0.2);
        expect(values[4]).toBeCloseTo(0.8);
        expect(values[9]).toBeCloseTo(0.15);
        expect(values[13]).toBeCloseTo(0.7);
        expect(values[17]).toBe(meshLoDDebugModeCode("lod-depth"));
        expect(mock.device.writes.filter((write) => write.buffer === ubo && write.byteLength === 80)).toHaveLength(initialWrites + 1);
        bindings.forEach(flush);
        expect(mock.device.writes.filter((write) => write.buffer === ubo && write.byteLength === 80)).toHaveLength(initialWrites + 1);
        setMeshLoDDebugView(asset, "none");
        material.roughnessFactor = 0.9;
        markMaterialUboDirty(material);
        bindings.forEach(flush);
        expect(new Float32Array(ubo.data.buffer)[9]).toBeCloseTo(0.9);
        expect(new Float32Array(ubo.data.buffer)[17]).toBe(0);
        const fullUploads = writeBuffer.mock.calls.filter(([buffer, offset]) => buffer === ubo && offset === 0);
        expect(fullUploads).toHaveLength(3);
        expect(fullUploads.every((call) => call[2] === fullUploads[0]![2])).toBe(true);
    });

    it.each(["baseColorTexture", "normalTexture"] as const)("rejects %s transforms introduced after scene registration", async (channel) => {
        const asset = await loadMeshLoD(engine, statueSource());
        const texture = createSolidTexture2D(engine, 1, 1, 1);
        const material = createPbrMaterial({ [channel]: texture });
        const scene = fakeScene(engine);
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        material[channel] = cloneTexture2D(texture, { uOffset: 0.25 });
        await expect(scene._deferredBuilders[0]!()).rejects.toMatchObject({ code: "MLOD_UNSUPPORTED_MATERIAL" });
    });

    it.each(["cpu", "gpu"] as const)("releases repeated offscreen and stereo target packets behind their task fence (%s)", async (selectionMode) => {
        const mock = createMockEngine();
        engine = mock.engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode });
        const scene = await build(asset, createPbrMaterial(), 1);
        const renderable = scene._renderables[0]!;
        const main = renderable.bind(engine, { ...SIG });
        flush(main);
        const liveBuffers = () => mock.device.buffers.filter((buffer) => !buffer.destroyed).length;
        const baseline = liveBuffers();
        for (let cycle = 0; cycle < 6; cycle++) {
            const tasks = Array.from({ length: cycle % 2 === 0 ? 1 : 2 }, (_, eye) => {
                const rt = createRenderTarget({ format: "rgba8unorm", dFormat: "depth24plus-stencil8", samples: 1, size: { width: 800, height: 600 } });
                const task = _createAutomaticRenderTask({ name: `pass-${cycle}-${eye}`, rt }, engine, scene);
                const binding = renderable.bind(engine, task._targetSignature);
                task._batchState = task._targetSignature._collectBatches!(undefined, binding);
                flush(binding);
                expect(renderable.bind(engine, task._targetSignature)._updateBatches![0]).toBe(binding._updateBatches![0]);
                return task;
            });
            const beforeRetirement = liveBuffers();
            tasks.forEach((task) => task.dispose());
            expect(liveBuffers()).toBe(beforeRetirement);
            let finishFence!: () => void;
            const fence = new Promise<void>((resolve) => (finishFence = resolve));
            Object.assign(mock.device.queue, { onSubmittedWorkDone: () => fence });
            flushGpuResourceRetirements(engine);
            await Promise.resolve();
            expect(liveBuffers()).toBe(beforeRetirement);
            finishFence();
            await waitForGpuResourceRetirements(engine);
            expect(liveBuffers()).toBe(baseline);
            const pass = createMockRenderPass();
            expect(main.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        }
        scene._disposables.forEach((dispose) => dispose());
    });

    it("keeps a replacement packet alive when the same target is rebound before an older fence drains", async () => {
        const mock = createMockEngine();
        engine = mock.engine;
        const asset = await loadMeshLoD(engine, statueSource());
        const scene = await build(asset, createPbrMaterial(), 1);
        const renderable = scene._renderables[0]!;
        const target = { ...SIG };
        const first = renderable.bind(engine, target);
        const firstState = target._collectBatches!(undefined, first)!;
        flush(first);
        firstState._release(engine);
        const replacement = renderable.bind(engine, target);
        flush(replacement);
        expect(replacement._updateBatches![0]).not.toBe(first._updateBatches![0]);
        Object.assign(mock.device.queue, { onSubmittedWorkDone: () => Promise.resolve() });
        await waitForGpuResourceRetirements(engine);
        expect(renderable.bind(engine, target)._updateBatches![0]).toBe(replacement._updateBatches![0]);
        const pass = createMockRenderPass();
        expect(replacement.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        expect(pass.indirectDraws[0]!.buffer.destroyed).toBe(false);
        scene._disposables.forEach((dispose) => dispose());
    });

    it("refreshes each binding's output pipeline when tone mapping is enabled, changed, or disabled", async () => {
        const asset = await loadMeshLoD(engine, statueSource());
        const scene = fakeScene(engine);
        scene.imageProcessing = { exposure: 0.8, contrast: 1.2, toneMappingEnabled: false };
        await build(asset, {} as PbrMaterialProps, 1, scene);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        const disabled = binding.pipeline;
        scene.imageProcessing.toneMappingEnabled = true;
        binding.update!(CONTEXT);
        const standard = binding.pipeline;
        expect(standard).not.toBe(disabled);
        scene.imageProcessing.toneMapping = AcesToneMapping;
        binding.update!(CONTEXT);
        expect(binding.pipeline).not.toBe(standard);
        scene.imageProcessing.toneMappingEnabled = false;
        binding.update!(CONTEXT);
        expect(binding.pipeline).toBe(disabled);
        scene.imageProcessing.exposure = 2;
        scene.imageProcessing.contrast = 0.7;
        binding.update!(CONTEXT);
        expect(binding.pipeline).toBe(disabled);
    });

    it.each(["cpu", "gpu"] as const)("reuses each target's buffers when render tasks rebind (%s)", async (selectionMode) => {
        const mock = createMockEngine();
        engine = mock.engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode });
        const scene = await build(asset, {} as PbrMaterialProps, 1);
        scene._renderableVersion = 0;
        engine._renderingContexts.push(scene);
        const renderable = scene._renderables[0]!;
        const targets = [{ ...SIG }, { ...SIG }];
        const drawBuffers = targets.map((target) => {
            const binding = renderable.bind(engine, target);
            flush(binding);
            const pass = createMockRenderPass();
            expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
            return pass.indirectDraws[0]!.buffer;
        });
        expect(drawBuffers[0]).not.toBe(drawBuffers[1]);
        const persistentBufferCount = () => mock.device.buffers.filter((buffer) => buffer.label !== "mesh-lod-readback").length;
        const bufferCount = persistentBufferCount();
        const version = scene._renderableVersion;
        for (let rebind = 0; rebind < 3; rebind++) {
            targets.forEach((target, index) => {
                const binding = renderable.bind(engine, target);
                flush(binding);
                const pass = createMockRenderPass();
                expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
                expect(pass.indirectDraws[0]!.buffer).toBe(drawBuffers[index]);
            });
        }
        expect(persistentBufferCount()).toBe(bufferCount);
        expect(scene._renderableVersion).toBe(version);
    });

    it.each([false, true])("isolates two disjoint camera cuts recorded before one submission (XR=%s)", async (xr) => {
        const mock = createMockEngine();
        engine = mock.engine;
        const asset = await loadMeshLoD(engine, statueSource());
        const scene = await build(asset, { doubleSided: true } as PbrMaterialProps, 2);
        const instances = scene._meshLoDRegistry!.batches[0]!.instances;
        instances[0]!.position.set(-1000, 0, 0);
        instances[1]!.position.set(1000, 0, 0);
        const cameras = [-1000, 1000].map((x, eye) => {
            const camera = fakeCamera();
            const world = new Float32Array(camera.worldMatrix);
            world[12] = x;
            Object.assign(camera, { worldMatrix: world });
            if (!xr) {
                return camera;
            }
            const xrCamera = createXrCamera(eye === 0 ? "left" : "right");
            const pose = new Float32Array(world);
            pose[14] = 10; // XR's right-handed eye pose.
            const projection = new Float32Array(getProjectionMatrix(camera, 800 / 600));
            // Undo LH/reverse-Z so updateXrCameraForView applies the real XR boundary.
            for (let column = 0; column < 4; column++) {
                const row2 = column * 4 + 2;
                projection[row2] = projection[column * 4 + 3]! - projection[row2]!;
            }
            for (let row = 0; row < 4; row++) {
                projection[8 + row] = -projection[8 + row]!;
            }
            updateXrCameraForView(xrCamera, { transform: { matrix: pose }, projectionMatrix: projection } as unknown as XRView, 800, 600, { x: 0, y: 0, width: 1, height: 1 });
            return xrCamera;
        });
        const bindings = cameras.map(() => scene._renderables[0]!.bind(engine, { ...SIG }));
        for (let eye = 0; eye < 2; eye++) {
            const binding = bindings[eye]!;
            binding._updateBatches![0]!.reset();
            binding.update!({ targetWidth: 800, targetHeight: 600, _camera: cameras[eye]! });
            binding._updateBatches![0]!.flush(engine);
        }
        const params = mock.device.buffers.filter((buffer) => buffer.label === "mesh-lod-params");
        expect(params).toHaveLength(2);
        const transforms = mock.device.buffers.filter((buffer) => buffer.label === "mesh-lod-instances" && buffer.data.length > 0);
        const runtime = asset._runtime;
        const selectedSlots = params.map((buffer, eye) => {
            const f = new Float32Array(buffer.data.buffer);
            const u = new Uint32Array(buffer.data.buffer);
            expect(f[24]).toBe(eye === 0 ? -1000 : 1000);
            const records = new Float32Array(transforms[eye]!.data.buffer);
            const model = runMeshLoDGpuSelection({
                nodes: packHierarchyNodes(runtime.hierarchyNodes),
                groups: packGroups(runtime.groups),
                clusters: packClusters(runtime.clusters),
                groupPageRefs: packGroupPageRefs(runtime.groupPageRefs),
                pageState: buildPageStateData(runtime.gpu.pages, runtime.pageRecords, runtime.generation),
                pageStoredBytes: runtime.pageRecords.map((record) => record.storedBytes),
                instances: records,
                instancesU32: new Uint32Array(records.buffer),
                priorState: new Uint32Array(u[40]! * 2),
                instanceCount: 2,
                nodeCount: runtime.hierarchyNodes.length,
                groupCount: runtime.groups.length,
                clusterCount: runtime.clusters.length,
                pageCount: runtime.pageRecords.length,
                wordsPerInstance: u[40]!,
                params: {
                    cameraPos: [f[24]!, f[25]!, f[26]!],
                    verticalFov: cameras[eye]!.fov,
                    near: f[27]!,
                    targetWidth: f[28]!,
                    targetHeight: f[29]!,
                    screenSpaceError: f[32]!,
                    lodHysteresis: runtime.settings.lodHysteresis,
                    levelCount: runtime.header.levelCount,
                    frustumPlanes: Array.from({ length: 6 }, (_, plane) => [f[plane * 4]!, f[plane * 4 + 1]!, f[plane * 4 + 2]!, f[plane * 4 + 3]!] as const),
                    coneCull: false,
                },
            });
            return [...new Set(model.selected.map((pair) => pair.instanceId))];
        });
        expect(selectedSlots).toEqual([[0], [1]]);
        const draws = bindings.map((binding) => {
            const pass = createMockRenderPass();
            expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
            return pass.indirectDraws[0]!.buffer;
        });
        expect(draws[0]).not.toBe(draws[1]);
        scene._disposables.forEach((dispose) => dispose());
        expect(params.every((buffer) => buffer.destroyed)).toBe(true);
    });

    it("populates public debug views without leaving default GPU selection", async () => {
        const mock = createMockEngine();
        engine = mock.engine;
        const asset = await loadMeshLoD(engine, statueSource());
        const scene = await build(asset, { doubleSided: true } as PbrMaterialProps, 1);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        const runtime = asset._runtime;
        const clusterId = runtime.clusters.findIndex((cluster) => runtime.pageRecords[cluster.pageId]!.pinned);
        const cluster = runtime.clusters[clusterId]!;
        const group = runtime.groups[cluster.groupId]!;
        // Minimal decoded geometry is enough to inspect the reserved diagnostic word.
        const pageState = buildPageStateData(runtime.gpu.pages, runtime.pageRecords, runtime.generation);
        pageState[cluster.pageId * PAGE_STATE_WORDS + 2] = 0;
        pageState[cluster.pageId * PAGE_STATE_WORDS + 3] = 0;
        const modes = ["none", "meshlet-id", "lod-depth", "selected-group", "page-residency", "requested-pages", "meshlet-cone"] as const;
        for (const view of modes) {
            setMeshLoDDebugView(asset, view);
            flush(binding);
            const params = mock.device.buffers.find((buffer) => buffer.label === "mesh-lod-params")!;
            const mode = new Uint32Array(params.data.buffer)[52]!;
            expect(mode).toBe(meshLoDDebugModeCode(view));
            expect(asset.diagnostics.selectionMode).toBe("gpu");
            const result = runMeshLoDGpuExpansion({
                selected: [{ clusterId, instanceId: 0 }],
                clusters: packClusters(runtime.clusters),
                groups: packGroups(runtime.groups),
                pageState,
                arena: new Uint32Array(cluster.indexOffset + cluster.triangleCount * 3),
                drawVertexCapacity: cluster.triangleCount * 3,
                debugMode: mode,
                coneCull: false,
            });
            const expected =
                view === "lod-depth" ? group.depth : view === "selected-group" ? cluster.groupId : view === "page-residency" ? 2 : view === "meshlet-cone" ? 0x3f800000 : 0;
            expect(result.drawVertices[3]).toBe(expected);
        }
        setMeshLoDDebugView(asset, "none");
        flush(binding);
        expect(asset.diagnostics.selectionMode).toBe("gpu");
    });

    it.each(["gpu", "cpu"] as const)("re-records the cached draw when switching from %s and back", async (initialMode) => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: initialMode });
        const scene = await build(asset, {} as PbrMaterialProps, 1);
        scene._renderableVersion = 0;
        engine._renderingContexts.push(scene);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        expect(binding._updateBatches).toHaveLength(1);

        flush(binding);
        const firstPass = createMockRenderPass();
        expect(binding.draw(firstPass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        const firstVersion = scene._renderableVersion;

        setMeshLoDSelectionMode(asset, initialMode === "gpu" ? "cpu" : "gpu");
        flush(binding);
        const secondPass = createMockRenderPass();
        expect(binding.draw(secondPass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        expect(scene._renderableVersion).toBeGreaterThan(firstVersion);
        expect(secondPass.indirectDraws[0]!.buffer).not.toBe(firstPass.indirectDraws[0]!.buffer);
        const secondVersion = scene._renderableVersion;

        setMeshLoDSelectionMode(asset, initialMode);
        flush(binding);
        const thirdPass = createMockRenderPass();
        expect(binding.draw(thirdPass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        expect(scene._renderableVersion).toBeGreaterThan(secondVersion);
        expect(thirdPass.indirectDraws[0]!.buffer).toBe(firstPass.indirectDraws[0]!.buffer);
    });

    it("issues exactly one indirect draw per distinct material key (GPU mode)", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = fakeScene(engine);
        const matA = { doubleSided: true } as PbrMaterialProps;
        const matB = { _unlit: true } as PbrMaterialProps;
        for (let i = 0; i < 2; i++) {
            addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, matA));
        }
        for (let i = 0; i < 3; i++) {
            addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, matB));
        }
        // Drain the single deferred builder once (what registerScene does).
        for (const builder of scene._deferredBuilders) {
            await builder();
        }
        // Two distinct material keys → two batches → two renderables.
        expect(scene._meshLoDRegistry!.batches).toHaveLength(2);
        expect(scene._renderables).toHaveLength(2);

        let draws = 0;
        for (const renderable of scene._renderables) {
            const binding = renderable.bind(engine, SIG);
            flush(binding);
            const pass = createMockRenderPass();
            draws += binding.draw(pass as unknown as GPURenderPassEncoder, engine);
        }
        expect(draws).toBe(2); // batch-scaled: one indirect draw per key, not per meshlet/instance
    });

    it("keeps a single indirect draw as instances grow within one key (GPU mode)", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = await build(asset, {} as PbrMaterialProps, 5);
        expect(scene._meshLoDRegistry!.batches).toHaveLength(1);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        flush(binding);
        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        expect(pass.indirectDraws).toHaveLength(1);
    });
});
