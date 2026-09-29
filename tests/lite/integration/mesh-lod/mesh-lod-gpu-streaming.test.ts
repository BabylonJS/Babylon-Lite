/** MeshLoD GPU-selection streaming integration tests (Task 7 — architecture §12.3 step 8).
 *
 *  GPU selection mode reads the per-page demand + diagnostics back from the selection
 *  compute's control buffer and feeds the shared runtime streaming engine, and grows the
 *  draw-vertex buffer make-before-break so refined geometry renders past the coarse bound.
 *
 *  The real WGSL compute + `mapAsync` loop is browser-validated (a mock device has no
 *  compute or buffer mapping). Here the readback is driven deterministically: the update
 *  batch's control→staging copy is asserted structurally, then `applyMeshLoDGpuReadback`
 *  (the seam the real mapAsync resolution calls) is fed a synthetic control buffer to
 *  prove decode → demand → streaming → adaptive draw growth end-to-end on the mock. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import {
    CONTROL_COUNT_WORD,
    CONTROL_FALLBACK_WORD,
    CONTROL_PAGE_DEMAND_OFFSET,
    CONTROL_TRIANGLE_WORD,
    CONTROL_VISIBLE_GROUP_WORD,
    applyMeshLoDGpuReadback,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDGpuBatchState } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { MeshLoDAssetRuntime } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";
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
    batchState(): MeshLoDGpuBatchState;
    flush(): void;
    submit(): void;
    settle(): Promise<void>;
    drawBuffers(): number;
}

async function setup(): Promise<GpuHarness> {
    const mock = createMockEngine();
    const { engine, encoder } = mock;
    const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
    const scene = fakeScene(engine);
    addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
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
        batchState: () => (batch as { _packet: { gpuBatchState: MeshLoDGpuBatchState } })._packet.gpuBatchState,
        flush(): void {
            updateBatch.reset();
            binding.update!(CONTEXT);
            updateBatch.flush(engine);
            binding.draw(createMockRenderPass() as unknown as GPURenderPassEncoder, engine);
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
    it("copies the control buffer to a MAP_READ staging slot after the compute passes", async () => {
        harness = await setup();
        harness.flush();
        const state = harness.batchState();
        const copy = harness.encoder.copies.find((c) => (c.dst as MockBuffer).label === "mesh-lod-readback");
        expect(copy).toBeTruthy();
        expect(copy!.src).toBe(state.controlBuffer);
        expect(copy!.size).toBe(state.controlWords * 4);
        // The staging ring holds a MAP_READ | COPY_DST buffer sized to the control buffer.
        const staging = (harness.engine._device as unknown as { buffers: MockBuffer[] }).buffers.find((b) => b.label === "mesh-lod-readback")!;
        expect(staging.size).toBe(state.controlWords * 4);
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
        applyMeshLoDGpuReadback(
            runtime,
            state,
            syntheticControl(state, finePageId, 4096, { count: 120, visible: 40, triangles: 6000, fallback: 5 }),
            runtime.gpu.pages.length,
            runtime.generation
        );

        // Diagnostics come straight from the control buffer readback.
        expect(runtime.diagnostics.selectedMeshletCount).toBe(120);
        expect(runtime.diagnostics.visibleGroupCount).toBe(40);
        expect(runtime.diagnostics.renderedTriangleCount).toBe(6000);
        expect(runtime.diagnostics.fallbackGroupCount).toBe(5);

        // The demanded fine page streams in over the in-memory source.
        await harness.settle();
        harness.submit();
        expect(runtime.gpu.residentPageCount).toBeGreaterThan(residentBefore);
        expect(runtime.gpu.pages[finePageId]!.state).toBe("gpu-resident");
    });

    it("grows the draw-vertex buffer make-before-break to fit the refined triangle count", async () => {
        harness = await setup();
        harness.flush();
        const state = harness.batchState();
        const runtime = harness.runtime;
        const drawBuffersBefore = harness.drawBuffers();
        expect(state.growthDrawVertexBound).toBe(0);

        // A refined selection reports far more triangles than the coarse capacity can hold.
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

        // The growth bound ratcheted up past the coarse per-instance vertex bound.
        expect(state.growthDrawVertexBound).toBeGreaterThan(0);
        expect(state.growthDrawVertexBound).toBeGreaterThanOrEqual(60000 * 3);

        // The next frame allocates a larger draw-vertex buffer (make-before-break).
        harness.flush();
        expect(harness.drawBuffers()).toBeGreaterThan(drawBuffersBefore);
        expect(state.drawVertexCapacity).toBeGreaterThanOrEqual(60000 * 3);
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
        expect(state.growthDrawVertexBound).toBe(0);
    });
});
