/** MeshLoD frame-reference lifecycle unit tests (Task 7.3 — architecture §14.1).
 *
 *  A page that contributes a rendered cluster gets its `frameRefCount` held for the
 *  command buffer being built, and a retirement callback decrements it only after that
 *  frame's submitted work drains — so current-frame residency survives until the fence
 *  completes (REQ-RENDER-4). This holds on the CPU streaming path (stepMeshLoDStreaming)
 *  and the GPU readback path (applyMeshLoDGpuReadback), which both drive the shared
 *  streaming engine. Cache-level eviction eligibility is covered by mesh-lod-cache. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { stepMeshLoDStreaming } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { CONTROL_COUNT_WORD, CONTROL_TRIANGLE_WORD, applyMeshLoDGpuReadback } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
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

    it("holds a frame reference on resident pages through the GPU readback path", async () => {
        const engine = createMockEngine().engine;
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = fakeScene(engine);
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
        for (const builder of scene._deferredBuilders) {
            await builder();
        }
        const binding = scene._renderables[0]!.bind(engine, SIG);
        binding.update!(CONTEXT); // builds the GPU batch state
        drainRetirements(engine);
        const runtime = asset._runtime;
        const state = (scene._meshLoDRegistry!.batches[0] as { _packet: { gpuBatchState: MeshLoDGpuBatchState } })._packet.gpuBatchState;
        const page0 = runtime.gpu.pages[0]!;
        expect(page0.frameRefCount).toBe(0);

        const control = new Uint32Array(state.controlWords);
        control[CONTROL_COUNT_WORD] = 10;
        control[CONTROL_TRIANGLE_WORD] = 46;
        applyMeshLoDGpuReadback(runtime, state, control, runtime.gpu.pages.length, runtime.generation);

        expect(page0.frameRefCount).toBeGreaterThan(0); // resident page held for the frame
        drainRetirements(engine);
        expect(page0.frameRefCount).toBe(0);
    });
});
