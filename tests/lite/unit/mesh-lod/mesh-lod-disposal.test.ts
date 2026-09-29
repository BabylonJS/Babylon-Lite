/** MeshLoD disposal + scene-pruning unit tests (Task 7.1 — architecture §14.2).
 *
 *  Disposal must be idempotent and generation-safe, stop mutation and drawing
 *  immediately, retire the GPU arena + shared selection buffers only after the next
 *  submitted frame drains (frame safety, REQ-RENDER-4), and release retained CPU page
 *  bytes + decoded indices once the batches are non-drawable. It must never write a
 *  scene reference into an asset, and repeated disposal is a no-op. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance, disposeMeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { cpuCacheUsedBytes } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-cache.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "./fixtures/gpu-mock.js";
import type { MockBuffer } from "./fixtures/gpu-mock.js";

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

interface Harness {
    engine: EngineContext;
    asset: MeshLoDAsset;
    scene: SceneContext;
    binding: ReturnType<SceneContext["_renderables"][number]["bind"]>;
}

async function setup(mode: "cpu" | "gpu"): Promise<Harness> {
    const engine = createMockEngine().engine;
    const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: mode });
    const scene = fakeScene(engine);
    addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    const binding = scene._renderables[0]!.bind(engine, SIG);
    binding.update!(CONTEXT); // one frame: builds GPU asset/batch buffers
    drainRetirements(engine);
    return { engine, asset, scene, binding };
}

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("MeshLoD disposal", () => {
    it("marks disposed, bumps generation, and releases CPU residency immediately", async () => {
        const { asset } = await setup("gpu");
        const runtime = asset._runtime;
        const gen = runtime.generation;
        expect(runtime.gpuSelection).not.toBeNull();

        disposeMeshLoDAsset(asset);

        expect(asset.state).toBe("disposed");
        expect(runtime.disposed).toBe(true);
        expect(runtime.generation).toBe(gen + 1);
        expect(runtime.gpuSelection).toBeNull();
        expect(runtime.scheduler).toBeNull();
        expect(runtime.gpu.residentPageCount).toBe(0);
        expect(cpuCacheUsedBytes(runtime.cpuPageCache)).toBe(0);
        expect(runtime.gpu.pages.every((p) => p.indices === null)).toBe(true);
    });

    it("retires the GPU arena + selection buffers only after the next submitted frame drains", async () => {
        const { engine, asset } = await setup("gpu");
        const runtime = asset._runtime;
        const arena = runtime.gpu.arena.buffer as unknown as MockBuffer;
        const meta = runtime.gpuSelection!.metaBuffer as unknown as MockBuffer;
        const pageState = runtime.gpuSelection!.pageStateBuffer as unknown as MockBuffer;

        disposeMeshLoDAsset(asset);
        // Frame safety: buffers still alive until the retirement drains.
        expect(arena.destroyed).toBe(false);
        expect(meta.destroyed).toBe(false);
        expect(pageState.destroyed).toBe(false);

        drainRetirements(engine);
        expect(arena.destroyed).toBe(true);
        expect(meta.destroyed).toBe(true);
        expect(pageState.destroyed).toBe(true);
    });

    it("is a no-op when disposed again (stable generation, no double destroy)", async () => {
        const { engine, asset } = await setup("gpu");
        const runtime = asset._runtime;
        disposeMeshLoDAsset(asset);
        drainRetirements(engine);
        const gen = runtime.generation;
        const buffersBefore = (engine._device as unknown as { buffers: MockBuffer[] }).buffers.length;

        expect(() => disposeMeshLoDAsset(asset)).not.toThrow();
        expect(asset.state).toBe("disposed");
        expect(runtime.generation).toBe(gen); // not bumped again
        expect((engine._device as unknown as { buffers: MockBuffer[] }).buffers.length).toBe(buffersBefore);
    });

    it("draws nothing after disposal and never rebuilds the GPU selection buffers", async () => {
        const { engine, asset, binding } = await setup("gpu");
        const runtime = asset._runtime;
        disposeMeshLoDAsset(asset);

        // Non-drawable immediately: the update clears the binding without rebuilding buffers.
        binding.update!(CONTEXT);
        expect(runtime.gpuSelection).toBeNull();
        binding.update!(CONTEXT); // idempotent across frames
        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(0);
        expect(pass.indirectDraws).toHaveLength(0);
    });

    it("retires the arena in CPU mode too (no shared selection buffers)", async () => {
        const { engine, asset } = await setup("cpu");
        const runtime = asset._runtime;
        expect(runtime.gpuSelection).toBeNull(); // CPU path never builds them
        const arena = runtime.gpu.arena.buffer as unknown as MockBuffer;
        disposeMeshLoDAsset(asset);
        expect(arena.destroyed).toBe(false);
        drainRetirements(engine);
        expect(arena.destroyed).toBe(true);
    });
});
