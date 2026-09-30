/** MeshLoD GPU-selection streaming integration tests (Task 7 — architecture §12.3 step 8).
 *
 *  GPU selection mode reads the per-page demand + diagnostics back from the selection
 *  compute's control buffer and feeds the shared runtime streaming engine. Draw
 *  storage grows before selecting newly resident fine geometry.
 *
 *  The real WGSL compute + `mapAsync` loop is browser-validated (a mock device has no
 *  compute or buffer mapping). Here the readback is driven deterministically: the update
 *  batch's control→staging copy is asserted structurally, then `applyMeshLoDGpuReadback`
 *  (the seam the real mapAsync resolution calls) is fed a synthetic control buffer to
 *  prove decode → demand → streaming → draw-capacity growth end-to-end on the mock. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance, setMeshLoDCacheBudget } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { arenaUsedBytes } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-cache.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import {
    CONTROL_COUNT_WORD,
    CONTROL_FALLBACK_WORD,
    CONTROL_OVERFLOW_WORD,
    CONTROL_PAGE_DEMAND_OFFSET,
    CONTROL_SELECTED_ERROR_WORD,
    CONTROL_TRIANGLE_WORD,
    CONTROL_UNMET_ERROR_WORD,
    CONTROL_VISIBLE_GROUP_WORD,
    INSTANCE_WORDS,
    PAGE_FLAG_RESIDENT,
    PAGE_STATE_WORDS,
    applyMeshLoDGpuReadback,
    packClusters,
    packGroupPageRefs,
    packGroups,
    packHierarchyNodes,
    packInstanceRecord,
    runMeshLoDGpuSelection,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDGpuBatchState } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDAsset, MeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { MeshLoDAssetRuntime } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockDevice, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";
import type { MockBuffer, MockEncoder } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
const statueSource = (): ArrayBuffer => new Uint8Array(readFileSync(STATUE)).slice().buffer as ArrayBuffer;

const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };

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

const CONTEXT = { targetWidth: 800, targetHeight: 600, _camera: fakeCamera() };

interface GpuHarness {
    engine: EngineContext;
    encoder: MockEncoder;
    asset: MeshLoDAsset;
    runtime: MeshLoDAssetRuntime;
    instances: MeshLoDInstance[];
    batchState(): MeshLoDGpuBatchState;
    flush(): void;
    submit(): void;
    settle(): Promise<void>;
    drawBuffers(): number;
}

async function setup(options: { limitBytes?: number; instanceCount?: number; visibleCount?: number; residencyHoldFrames?: number } = {}): Promise<GpuHarness> {
    const mock = createMockEngine(options.limitBytes === undefined ? undefined : createMockDevice(options.limitBytes));
    const { engine, encoder } = mock;
    const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu", residencyHoldFrames: options.residencyHoldFrames });
    const scene = fakeScene(engine);
    const instances: MeshLoDInstance[] = [];
    const material = {} as PbrMaterialProps;
    for (let i = 0; i < (options.instanceCount ?? 1); i++) {
        const instance = createMeshLoDInstance(asset, material, { visible: i < (options.visibleCount ?? options.instanceCount ?? 1) });
        instances.push(instance);
        addMeshLoDInstanceToScene(scene, instance);
    }
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    const binding = scene._renderables[0]!.bind(engine, SIG);
    const batch = scene._meshLoDRegistry!.batches[0]!;
    const updateBatch = binding._updateBatches![0]!;
    return {
        engine,
        encoder,
        asset,
        runtime: asset._runtime,
        instances,
        batchState: () => (batch as { _packet: { gpuBatchState: MeshLoDGpuBatchState } })._packet.gpuBatchState,
        flush(): void {
            updateBatch.reset();
            binding.update!(CONTEXT);
            updateBatch.flush(engine);
            binding.draw(createMockRenderPass() as unknown as GPURenderPassEncoder, engine);
            engine._finishOptionalFrame?.(true);
        },
        submit(): void {
            const retirements = engine._retirements;
            engine._retirements = null;
            retirements?.forEach((retire) => retire());
        },
        async settle(): Promise<void> {
            for (let i = 0; i < 6; i++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        },
        drawBuffers(): number {
            return (engine._device as unknown as { buffers: MockBuffer[] }).buffers.filter((b) => b.label === "mesh-lod-draw-vertices" && !b.destroyed).length;
        },
    };
}

/** Build a control buffer for the batch that demands `finePageId` and reports diagnostics. */
function syntheticControl(
    state: MeshLoDGpuBatchState,
    finePageId: number,
    benefit: number,
    diag: { count: number; visible: number; triangles: number; fallback: number }
): Uint32Array {
    const control = new Uint32Array(state.controlWords);
    control[CONTROL_COUNT_WORD] = diag.count;
    control[CONTROL_VISIBLE_GROUP_WORD] = diag.visible;
    control[CONTROL_TRIANGLE_WORD] = diag.triangles;
    control[CONTROL_FALLBACK_WORD] = diag.fallback;
    control[CONTROL_PAGE_DEMAND_OFFSET + finePageId] = benefit;
    return control;
}

let harness: GpuHarness;

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("MeshLoD GPU streaming — demand readback + adaptive draw growth", () => {
    it("ages only selected fine pages and retires unused GPU-resident pages after the last in-flight fence", async () => {
        harness = await setup({ residencyHoldFrames: 1 });
        const runtime = harness.runtime;
        const pinnedBytes = arenaUsedBytes(runtime.gpu.arena);
        harness.flush();
        const state = harness.batchState();
        const finePageId = runtime.pageRecords.findIndex((record) => !record.pinned);
        applyMeshLoDGpuReadback(
            runtime,
            state,
            syntheticControl(state, finePageId, 2048, { count: 0, visible: 1, triangles: 1, fallback: 0 }),
            runtime.gpu.pages.length,
            runtime.generation
        );
        await harness.settle();
        harness.submit();
        const page = runtime.gpu.pages[finePageId]!;
        expect(page.state).toBe("gpu-resident");
        const usedAtUpload = page.lastUsedFrame;
        const fineClusterId = runtime.clusters.findIndex((cluster) => cluster.pageId === finePageId);
        expect(fineClusterId).toBeGreaterThanOrEqual(0);

        harness.flush();
        expect(page.lastUsedFrame).toBe(usedAtUpload);
        applyMeshLoDGpuReadback(
            runtime,
            state,
            syntheticControl(state, finePageId, 0, { count: 1, visible: 1, triangles: 1, fallback: 0 }),
            runtime.gpu.pages.length,
            runtime.generation,
            new Uint32Array([fineClusterId, 0]),
            runtime.frameIndex
        );
        expect(page.lastUsedFrame).toBe(runtime.frameIndex);
        harness.submit();

        setMeshLoDCacheBudget(harness.asset, pinnedBytes);
        harness.flush();
        expect(page.state).toBe("evicting");
        expect(arenaUsedBytes(runtime.gpu.arena)).toBeGreaterThan(pinnedBytes);
        harness.submit();
        expect(page.state).toBe("unrequested");
        expect(arenaUsedBytes(runtime.gpu.arena)).toBe(pinnedBytes);
    });

    it("copies the control buffer to a MAP_READ staging slot after the compute passes", async () => {
        harness = await setup();
        harness.flush();
        const state = harness.batchState();
        const copy = harness.encoder.copies.find((c) => (c.dst as MockBuffer).label === "mesh-lod-readback");
        expect(copy).toBeTruthy();
        expect(copy!.src).toBe(state.controlBuffer);
        expect(copy!.size).toBe(state.controlWords * 4);
        expect(harness.encoder.copies.some((c) => c.src.label === "mesh-lod-selected" && c.dst === copy!.dst && c.dstOffset === copy!.size)).toBe(true);
        // The staging ring holds a MAP_READ | COPY_DST buffer sized to the control buffer.
        const staging = (harness.engine._device as unknown as { buffers: MockBuffer[] }).buffers.find((b) => b.label === "mesh-lod-readback")!;
        expect(staging.size).toBe(state.controlWords * 4 + state.selectedCapacity * 8);
    });

    it("feeds decoded demand into the streaming engine and refines resident pages", async () => {
        harness = await setup();
        harness.flush();
        const state = harness.batchState();
        const runtime = harness.runtime;
        const residentBefore = runtime.gpu.residentPageCount;
        const finePageId = runtime.pageRecords.findIndex((r) => !r.pinned);
        expect(finePageId).toBeGreaterThan(0);

        // Stand in for the async mapAsync resolution: demand the fine page, report diagnostics.
        const control = syntheticControl(state, finePageId, 4096, { count: 120, visible: 40, triangles: 6000, fallback: 5 });
        control[CONTROL_SELECTED_ERROR_WORD] = new Uint32Array(new Float32Array([4.25]).buffer)[0]!;
        control[CONTROL_UNMET_ERROR_WORD] = new Uint32Array(new Float32Array([9.5]).buffer)[0]!;
        applyMeshLoDGpuReadback(runtime, state, control, runtime.gpu.pages.length, runtime.generation);

        // Diagnostics come straight from the control buffer readback.
        expect(runtime.diagnostics.selectedMeshletCount).toBe(120);
        expect(runtime.diagnostics.visibleGroupCount).toBe(40);
        expect(runtime.diagnostics.renderedTriangleCount).toBe(6000);
        expect(runtime.diagnostics.fallbackGroupCount).toBe(5);
        expect(runtime.diagnostics.maximumSelectedErrorPixels).toBe(4.25);
        expect(runtime.diagnostics.maximumUnmetErrorPixels).toBe(9.5);

        // The demanded fine page streams in over the in-memory source.
        await harness.settle();
        harness.submit();
        expect(runtime.gpu.residentPageCount).toBeGreaterThan(residentBefore);
        expect(runtime.gpu.pages[finePageId]!.state).toBe("gpu-resident");
    });

    it("grows the draw-vertex buffer make-before-break as demanded fine pages become resident", async () => {
        harness = await setup();
        harness.flush();
        const state = harness.batchState();
        const runtime = harness.runtime;
        const drawBuffersBefore = harness.drawBuffers();
        const coarseCapacity = state.drawVertexCapacity;

        const finePageId = runtime.pageRecords.findIndex((r) => !r.pinned);
        applyMeshLoDGpuReadback(
            runtime,
            state,
            syntheticControl(state, finePageId, 2048, { count: 400, visible: 60, triangles: 60000, fallback: 8 }),
            runtime.gpu.pages.length,
            runtime.generation
        );
        await harness.settle();
        harness.submit();

        harness.flush();
        expect(harness.drawBuffers()).toBeGreaterThan(drawBuffersBefore);
        expect(state.drawVertexCapacity).toBeGreaterThan(coarseCapacity);
        expect(state.residentDrawVertexBound).toBe(state.drawVertexCapacity);
    });

    it("reserves the full resident cut on the first frame after a fine page upload without waiting for readback", async () => {
        harness = await setup();
        harness.flush();
        const runtime = harness.runtime;
        const state = harness.batchState();
        const priorCapacity = state.drawVertexCapacity;
        const priorBuffer = state.drawVertexBuffer;
        const pageId = runtime.pageRecords.findIndex((record, id) => !record.pinned && runtime.clusters.some((cluster) => cluster.pageId === id));
        expect(pageId).toBeGreaterThan(0);
        const page = runtime.gpu.pages[pageId]!;
        page.state = "gpu-resident";
        page.arenaOffset = runtime.gpu.arena.capacityBytes - runtime.pageRecords[pageId]!.decodedBytes;
        harness.flush();
        const required = runtime.clusters.reduce((total, cluster) => {
            const p = runtime.gpu.pages[cluster.pageId]!;
            return total + (p.state === "gpu-resident" && p.arenaOffset >= 0 ? cluster.triangleCount * 3 : 0);
        }, 0);
        expect(required).toBeGreaterThan(priorCapacity);
        expect(state.residentDrawVertexBound).toBe(required);
        expect(state.drawVertexCapacity).toBeGreaterThanOrEqual(required);
        expect(state.drawVertexBuffer).not.toBe(priorBuffer);
    });

    it("caps an oversized resident envelope without rejecting a small selected cut or hidden instances", async () => {
        const limitBytes = 128 * 1024 * 1024;
        harness = await setup({ limitBytes, instanceCount: 20, visibleCount: 1 });
        const initialDraw = (harness.engine._device as unknown as { buffers: MockBuffer[] }).buffers.find((buffer) => buffer.label === "mesh-lod-draw-vertices");
        expect(initialDraw?.size).toBe(3 * 16); // the GPU packet does not allocate a coarse CPU draw stream
        harness.flush();
        const state = harness.batchState();
        const runtime = harness.runtime;
        for (let i = 0; i < runtime.gpu.pages.length; i++) {
            const page = runtime.gpu.pages[i]!;
            if (!runtime.pageRecords[i]!.pinned) {
                page.state = "gpu-resident";
                page.arenaOffset = runtime.gpu.arena.capacityBytes - runtime.pageRecords[i]!.decodedBytes;
            }
        }
        harness.flush();
        const residentVertices = runtime.clusters.reduce((count, cluster) => count + cluster.triangleCount * 3, 0);
        expect(residentVertices * harness.instances.length * 16).toBeGreaterThan(limitBytes);
        expect(state.drawVertexCapacity).toBe(residentVertices);

        harness.instances[1]!.visible = true;
        harness.flush();
        expect(state.drawVertexCapacity).toBe(residentVertices * 2); // visibility changed without a residency change

        for (const instance of harness.instances) {
            instance.visible = true;
        }
        harness.flush(); // A coarse selected cut fits even though the resident envelope does not.
        expect(state.drawVertexCapacity).toBe(Math.floor(limitBytes / 48) * 3);
        expect((state.drawVertexBuffer as unknown as MockBuffer).size).toBeLessThanOrEqual(limitBytes);

        const records = new Float32Array(harness.instances.length * INSTANCE_WORDS);
        const words = new Uint32Array(records.buffer);
        for (let i = 0; i < harness.instances.length; i++) {
            const instance = harness.instances[i]!;
            packInstanceRecord(records, words, i * INSTANCE_WORDS, instance.worldMatrix, instance.visible, instance._instanceId);
        }
        const pageState = new Uint32Array(runtime.gpu.pages.length * PAGE_STATE_WORDS);
        for (let i = 0; i < runtime.gpu.pages.length; i++) {
            pageState[i * PAGE_STATE_WORDS] = PAGE_FLAG_RESIDENT;
        }
        const wordsPerInstance = Math.max(Math.ceil(runtime.groups.length / 32), 1);
        const cut = runMeshLoDGpuSelection({
            nodes: packHierarchyNodes(runtime.hierarchyNodes),
            groups: packGroups(runtime.groups),
            clusters: packClusters(runtime.clusters),
            groupPageRefs: packGroupPageRefs(runtime.groupPageRefs),
            pageState,
            pageStoredBytes: runtime.pageRecords.map((record) => record.storedBytes),
            instances: records,
            instancesU32: words,
            priorState: new Uint32Array(wordsPerInstance * harness.instances.length),
            instanceCount: harness.instances.length,
            nodeCount: runtime.hierarchyNodes.length,
            groupCount: runtime.groups.length,
            clusterCount: runtime.clusters.length,
            pageCount: runtime.pageRecords.length,
            wordsPerInstance,
            params: {
                cameraPos: [0, 0, -10],
                verticalFov: 0.8,
                near: 0.1,
                targetWidth: 800,
                targetHeight: 600,
                frustumPlanes: [],
                screenSpaceError: runtime.settings.screenSpaceError,
                lodHysteresis: runtime.settings.lodHysteresis,
                levelCount: runtime.header.levelCount,
            },
        });
        expect(cut.overflow).toBe(false);
        expect(cut.renderedTriangleCount * 3).toBeGreaterThan(0);
        expect(cut.renderedTriangleCount * 3).toBeLessThan(state.drawVertexCapacity);
    });

    it("surfaces a genuinely oversized selected cut instead of silently drawing a prefix", async () => {
        harness = await setup();
        harness.flush();
        const state = harness.batchState();
        const runtime = harness.runtime;
        const control = syntheticControl(state, 0, 0, { count: 0, visible: 1, triangles: 100, fallback: 0 });
        control[CONTROL_OVERFLOW_WORD] = 2;
        applyMeshLoDGpuReadback(runtime, state, control, runtime.gpu.pages.length, runtime.generation);
        expect(() => harness.flush()).toThrowError(expect.objectContaining({ code: "MLOD_DEVICE_LIMIT" }));
    });

    it("drops a readback whose generation no longer matches (post-disposal / recovery)", async () => {
        harness = await setup();
        harness.flush();
        const state = harness.batchState();
        const runtime = harness.runtime;
        const before = runtime.diagnostics.renderedTriangleCount;
        const finePageId = runtime.pageRecords.findIndex((r) => !r.pinned);
        // Stale generation → the readback is ignored, streaming untouched.
        applyMeshLoDGpuReadback(
            runtime,
            state,
            syntheticControl(state, finePageId, 4096, { count: 99, visible: 9, triangles: 9999, fallback: 1 }),
            runtime.gpu.pages.length,
            runtime.generation + 1
        );
        expect(runtime.diagnostics.renderedTriangleCount).toBe(before);
        expect(state.pendingError).toBeNull();
    });
});
