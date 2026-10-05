/** MeshLoD frame-reference lifecycle unit tests (Task 7.3 — architecture §14.1).
 *
 *  A page that contributes a rendered cluster gets its `frameRefCount` held for the
 *  command buffer being built, and a retirement callback decrements it only after that
 *  frame's submitted work drains — so current-frame residency survives until the fence
 *  completes (REQ-RENDER-4). This holds on the CPU streaming path (stepMeshLoDStreaming)
 *  and at GPU selection submission, before asynchronous readback. Cache-level
 *  eviction eligibility is covered by mesh-lod-cache. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { finishMeshLoDFrame, queueMeshLoDFrame, stepMeshLoDStreaming } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import { addMeshLoDInstanceToScene, driveMeshLoDStreaming } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import type { MeshLoDInstanceSelection, MeshLoDSceneBatch } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import {
    CONTROL_COUNT_WORD,
    CONTROL_PAGE_DEMAND_OFFSET,
    CONTROL_TRIANGLE_WORD,
    applyMeshLoDGpuReadback,
    createMeshLoDGpuBatchState,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDGpuBatchState } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockEngine } from "./fixtures/gpu-mock.js";

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

function drainRetirements(engine: EngineContext): void {
    const retirements = engine._retirements;
    engine._retirements = null;
    retirements?.forEach((r) => r());
}

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("MeshLoD frame references (§14.1)", () => {
    it("discards an aborted frame's demand and CPU usage without advancing the asset clock", async () => {
        const engine = createMockEngine().engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const clusterId = asset._runtime.clusters.findIndex((cluster) => asset._runtime.gpu.pages[cluster.pageId]!.state === "gpu-resident");
        expect(clusterId).toBeGreaterThanOrEqual(0);
        const page = asset._runtime.gpu.pages[asset._runtime.clusters[clusterId]!.pageId]!;
        const scene = fakeScene(engine);
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
        const batch = scene._meshLoDRegistry!.batches[0]!;
        driveMeshLoDStreaming(batch, [
            {
                instance: batch.instances[0]!,
                result: {
                    selectedClusterIds: new Uint32Array([clusterId]),
                    desiredPages: [{ pageId: 1, priority: 1 }],
                    fineRequired: new Uint8Array(0),
                    visibleGroupCount: 1,
                    fallbackGroupCount: 0,
                    renderedTriangleCount: 1,
                    selectedMeshletCount: 1,
                    maximumSelectedErrorPixels: 0,
                    maximumUnmetErrorPixels: 0,
                },
            },
        ]);
        expect(page.lastUsedFrame).toBe(1);
        engine._finishOptionalFrame?.(false);
        expect(page.lastUsedFrame).toBe(0);
        expect(asset._runtime.frameIndex).toBe(0);
        expect(asset._runtime.scheduler).toBeNull();
        drainRetirements(engine);
    });

    it("retains per-batch GPU demand across pending readbacks without advancing on completion or accepting stale feedback", async () => {
        const engine = createMockEngine().engine;
        const runtime = (await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu", obsoleteRequestGraceFrames: 0 }))._runtime;
        const fine = runtime.pageRecords.map((record, id) => (!record.pinned ? id : -1)).filter((id) => id >= 0);
        const states = [createMeshLoDGpuBatchState(), createMeshLoDGpuBatchState()];
        for (const state of states) {
            state.device = engine._device;
            queueMeshLoDFrame(runtime, state, "gpu", null);
        }
        engine._finishOptionalFrame?.(true);
        expect(runtime.frameIndex).toBe(1);
        const control = (pageId: number): Uint32Array => {
            const words = new Uint32Array(CONTROL_PAGE_DEMAND_OFFSET + runtime.pageRecords.length);
            words[CONTROL_PAGE_DEMAND_OFFSET + pageId] = 4096;
            return words;
        };
        for (let i = 0; i < 2; i++) {
            applyMeshLoDGpuReadback(runtime, states[i]!, control(fine[i]!), runtime.pageRecords.length, runtime.generation, 1);
        }
        expect(runtime.frameIndex).toBe(1);
        expect([...runtime.scheduler!.requests.keys()]).toEqual(fine.slice(0, 2));

        for (const state of states) {
            queueMeshLoDFrame(runtime, state, "gpu", null); // pending readback does not mean empty demand
        }
        engine._finishOptionalFrame?.(true);
        expect(runtime.frameIndex).toBe(2);
        expect([...runtime.scheduler!.requests.keys()]).toEqual(fine.slice(0, 2));
        applyMeshLoDGpuReadback(runtime, states[1]!, control(fine[2]!), runtime.pageRecords.length, runtime.generation, 2);
        applyMeshLoDGpuReadback(runtime, states[1]!, control(fine[3]!), runtime.pageRecords.length, runtime.generation, 1);
        expect(runtime.frameIndex).toBe(2);
        expect(runtime.scheduler!.requests.has(fine[2]!)).toBe(true);
        expect(runtime.scheduler!.requests.has(fine[3]!)).toBe(false);
        expect(runtime.scheduler!.requests.has(fine[0]!)).toBe(true);
    });

    it("merges three material batches once per submitted frame, preserving all current requests with zero grace", async () => {
        const engine = createMockEngine().engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu", obsoleteRequestGraceFrames: 0 });
        const scene = fakeScene(engine);
        const fine = asset._runtime.pageRecords
            .map((record, id) => (!record.pinned ? id : -1))
            .filter((id) => id >= 0)
            .slice(0, 3);
        expect(fine).toHaveLength(3);
        const batches: MeshLoDSceneBatch[] = [];
        for (let i = 0; i < 3; i++) {
            const instance = createMeshLoDInstance(asset, {} as PbrMaterialProps);
            addMeshLoDInstanceToScene(scene, instance);
            batches.push(scene._meshLoDRegistry!.batches[i]!);
        }
        const contribute = (batch: MeshLoDSceneBatch, pageId: number, priority: number): void => {
            const selection: MeshLoDInstanceSelection = {
                instance: batch.instances[0]!,
                result: {
                    selectedClusterIds: new Uint32Array([0]),
                    desiredPages: [{ pageId, priority }],
                    fineRequired: new Uint8Array(0),
                    visibleGroupCount: 1,
                    fallbackGroupCount: 0,
                    renderedTriangleCount: 1,
                    selectedMeshletCount: 1,
                    maximumSelectedErrorPixels: 0,
                    maximumUnmetErrorPixels: 0,
                },
            };
            driveMeshLoDStreaming(batch, [selection]);
        };
        for (let i = 0; i < 3; i++) {
            contribute(batches[i]!, fine[i]!, 3 - i);
        }
        expect(asset._runtime.frameIndex).toBe(0);
        engine._finishOptionalFrame?.(true);
        expect(asset._runtime.frameIndex).toBe(1);
        expect([...asset._runtime.scheduler!.requests.keys()]).toEqual(fine);
        drainRetirements(engine);

        for (let i = 2; i >= 0; i--) {
            contribute(batches[i]!, fine[i]!, 4 - i);
        }
        engine._finishOptionalFrame?.(true);
        expect(asset._runtime.frameIndex).toBe(2);
        expect([...asset._runtime.scheduler!.requests.keys()]).toEqual(fine);
        drainRetirements(engine);

        finishMeshLoDFrame(engine); // a later engine frame with none of these batches
        expect(asset._runtime.frameIndex).toBe(3);
        expect(asset._runtime.scheduler!.requests.size).toBe(0);
    });

    it("holds a frame reference on referenced pages and releases it only when the fence drains", async () => {
        const engine = createMockEngine().engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const runtime = asset._runtime;
        const page0 = runtime.gpu.pages[0]!;
        expect(page0.state).toBe("gpu-resident");
        expect(page0.frameRefCount).toBe(0);

        stepMeshLoDStreaming(runtime, [], [0]);
        expect(page0.frameRefCount).toBe(1); // held for the in-flight frame
        expect(page0.lastUsedFrame).toBe(runtime.frameIndex);
        expect(engine._retirements?.length ?? 0).toBeGreaterThan(0); // decrement queued behind the fence

        // Queue submission is NOT completed work: the reference stands until the fence drains.
        drainRetirements(engine);
        expect(page0.frameRefCount).toBe(0);
    });

    it("accumulates a reference per in-flight frame and releases each on its own fence", async () => {
        const engine = createMockEngine().engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const runtime = asset._runtime;
        const page0 = runtime.gpu.pages[0]!;

        stepMeshLoDStreaming(runtime, [], [0]);
        stepMeshLoDStreaming(runtime, [], [0]); // second frame in flight before the first drained
        expect(page0.frameRefCount).toBe(2);

        drainRetirements(engine);
        expect(page0.frameRefCount).toBe(0);
    });

    it("holds advertised resident pages before GPU selection without aging unselected pages on readback", async () => {
        const engine = createMockEngine().engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = fakeScene(engine);
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
        for (const builder of scene._deferredBuilders) {
            await builder();
        }
        const binding = scene._renderables[0]!.bind(engine, SIG);
        const runtime = asset._runtime;
        const page0 = runtime.gpu.pages[0]!;
        page0.lastUsedFrame = 0;
        binding.update!(CONTEXT); // protects GPU inputs before any async result
        expect(page0.frameRefCount).toBe(1);
        expect(page0.lastUsedFrame).toBe(0);
        engine._finishOptionalFrame?.(true);
        const state = (scene._meshLoDRegistry!.batches[0] as { _packet: { gpuBatchState: MeshLoDGpuBatchState } })._packet.gpuBatchState;

        const control = new Uint32Array(state.controlWords);
        control[CONTROL_COUNT_WORD] = 10;
        control[CONTROL_TRIANGLE_WORD] = 46;
        applyMeshLoDGpuReadback(runtime, state, control, runtime.gpu.pages.length, runtime.generation, runtime.frameIndex);

        expect(page0.frameRefCount).toBe(1);
        expect(page0.lastUsedFrame).toBe(0); // no selected cluster used it
        drainRetirements(engine);
        expect(page0.frameRefCount).toBe(0);
    });
});
