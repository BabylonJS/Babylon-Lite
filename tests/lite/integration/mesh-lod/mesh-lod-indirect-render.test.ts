/** MeshLoD GPU indirect-render integration tests (Task 5.3).
 *
 *  Two layers, both Node-hosted against a mock device:
 *  1. `runMeshLoDGpuExpansion` — the deterministic TS mirror of the WGSL
 *     `expandClusters` kernel — is checked for exact draw-vertex records over a tiny
 *     synthetic arena, meshlet-count scaling, and bounded overflow.
 *  2. The PBR renderable in GPU mode is driven end-to-end: it queues one compute pass
 *     (selection + indirect expansion + finalize) into the shared MeshLoD update batch
 *     flushed before the render pass, then issues exactly one `drawIndirect` per batch
 *     regardless of meshlet or instance count, and zero draws for an empty batch. Real
 *     WebGPU pixels are validated in the browser (Task 5.4). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { PAGE_STATE_WORDS, VERTEX_WORDS, packClusters, runMeshLoDGpuExpansion } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDCluster } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import type { DrawUpdateBatch } from "../../../../packages/babylon-lite/src/render/renderable.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";
import type { MockEncoder } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
const statueSource = (): ArrayBuffer => new Uint8Array(readFileSync(STATUE)).slice().buffer as ArrayBuffer;

function cluster(over: Partial<MeshLoDCluster> = {}): MeshLoDCluster {
    return {
        center: [0, 0, 0],
        radius: 1,
        error: 0,
        groupId: 0,
        refinedGroupId: -1,
        pageId: 0,
        vertexOffset: 0,
        indexOffset: 0,
        vertexCount: 3,
        triangleCount: 1,
        sourceTriangleCount: 1,
        ...over,
    };
}

describe("MeshLoD GPU expansion model", () => {
    // One page: 3 vertices (24 B each = 72 B) then 3 u16 indices [0,1,2] at byte 72.
    function tinyArena(indices: number[]): Uint32Array {
        const arena = new Uint32Array(20);
        for (let i = 0; i < indices.length; i++) {
            const byte = 72 + i * 2;
            arena[byte >>> 2]! |= (indices[i]! & 0xffff) << ((byte & 2) * 8);
        }
        return arena;
    }
    function pageState(): Uint32Array {
        const ps = new Uint32Array(PAGE_STATE_WORDS);
        ps[0] = 0x1; // resident
        ps[1] = 0; // arena base
        ps[2] = 0; // absolute vertex byte offset
        ps[3] = 72; // absolute index byte offset
        return ps;
    }

    it("expands one cluster into exact absolute arena vertex-word offsets", () => {
        const result = runMeshLoDGpuExpansion({
            selected: [{ clusterId: 0, instanceId: 0 }],
            clusters: packClusters([cluster({ indexOffset: 0, triangleCount: 1 })]),
            pageState: pageState(),
            arena: tinyArena([0, 1, 2]),
            drawVertexCapacity: 16,
        });
        expect(result.vertexCount).toBe(3);
        expect(result.overflow).toBe(false);
        // localVertex k → word offset k * VERTEX_WORDS; clusterId 0; slot 0; flags 0.
        expect(Array.from(result.drawVertices.slice(0, 12))).toEqual([0 * VERTEX_WORDS, 0, 0, 0, 1 * VERTEX_WORDS, 0, 0, 0, 2 * VERTEX_WORDS, 0, 0, 0]);
    });

    it("honors the cluster index winding order", () => {
        const result = runMeshLoDGpuExpansion({
            selected: [{ clusterId: 0, instanceId: 2 }],
            clusters: packClusters([cluster()]),
            pageState: pageState(),
            arena: tinyArena([2, 0, 1]),
            drawVertexCapacity: 16,
        });
        expect(Array.from(result.drawVertices.slice(0, 12))).toEqual([2 * VERTEX_WORDS, 0, 2, 0, 0 * VERTEX_WORDS, 0, 2, 0, 1 * VERTEX_WORDS, 0, 2, 0]);
    });

    it("scales expanded vertices with selected meshlet count", () => {
        const result = runMeshLoDGpuExpansion({
            selected: [
                { clusterId: 0, instanceId: 0 },
                { clusterId: 0, instanceId: 0 },
                { clusterId: 0, instanceId: 1 },
            ],
            clusters: packClusters([cluster()]),
            pageState: pageState(),
            arena: tinyArena([0, 1, 2]),
            drawVertexCapacity: 64,
        });
        expect(result.vertexCount).toBe(9); // 3 meshlets × 3 indices
    });

    it("flags overflow and clamps to capacity without OOB writes", () => {
        const result = runMeshLoDGpuExpansion({
            selected: [{ clusterId: 0, instanceId: 0 }],
            clusters: packClusters([cluster()]),
            pageState: pageState(),
            arena: tinyArena([0, 1, 2]),
            drawVertexCapacity: 2,
        });
        expect(result.overflow).toBe(true);
        expect(result.vertexCount).toBe(2);
        expect(result.drawVertices.length).toBe(2 * 4);
    });
});

// ── GPU render path (mock device) ──

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

async function buildGpuScene(asset: MeshLoDAsset, engine: EngineContext, material: PbrMaterialProps, instanceCount: number): Promise<SceneContext> {
    const scene = fakeScene(engine);
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

let engine: EngineContext;
let encoder: MockEncoder;

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
    const mock = createMockEngine();
    engine = mock.engine;
    encoder = mock.encoder;
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

function flushBinding(binding: { update?: (c: typeof CONTEXT) => void; _updateBatches?: readonly DrawUpdateBatch[] }, context = CONTEXT): void {
    const batch = binding._updateBatches?.[0];
    expect(batch).toBeTruthy();
    batch!.reset();
    binding.update!(context);
    batch!.flush(engine);
}

describe("MeshLoD GPU indirect rendering", () => {
    it("queues two compute passes (selection then indirect expand) and one indirect draw", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = await buildGpuScene(asset, engine, {} as PbrMaterialProps, 1);
        expect(scene._renderables).toHaveLength(1);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        expect(binding._updateBatches).toHaveLength(1); // MeshLoD compute batch attached
        flushBinding(binding);

        expect(encoder.computePasses).toHaveLength(2);
        // Pass 1: traverse, evaluate, select, demand, clamp (direct).
        expect(encoder.computePasses[0]!.dispatches).toHaveLength(5);
        expect(encoder.computePasses[0]!.dispatches.every((d) => d.kind === "direct")).toBe(true);
        // Pass 2: expandClusters (indirect) + finalizeDraw (direct).
        expect(encoder.computePasses[1]!.dispatches).toHaveLength(2);
        expect(encoder.computePasses[1]!.dispatches[0]!.kind).toBe("indirect");
        expect(encoder.computePasses[1]!.dispatches[1]!.kind).toBe("direct");

        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        expect(pass.indirectDraws).toHaveLength(1);
        expect(pass.setBindGroups).toEqual([{ index: 1 }]);
    });

    it("keeps one indirect draw per batch as the instance count grows", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = await buildGpuScene(asset, engine, {} as PbrMaterialProps, 4);
        expect(scene._meshLoDRegistry!.batches).toHaveLength(1);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        flushBinding(binding);
        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        expect(pass.indirectDraws).toHaveLength(1);
    });

    it("draws nothing when the batch has no visible instances", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = await buildGpuScene(asset, engine, {} as PbrMaterialProps, 1);
        scene._meshLoDRegistry!.batches[0]!.instances[0]!.visible = false;
        // A fully-hidden batch still binds; the GPU path resolves no active buffers → 0 draws.
        scene._meshLoDRegistry!.batches[0]!.instances.length = 0;
        const binding = scene._renderables[0]!.bind(engine, SIG);
        flushBinding(binding);
        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(0);
    });

    it("builds the GPU path for base/double-sided/unlit material variants", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        for (const material of [{} as PbrMaterialProps, { doubleSided: true } as PbrMaterialProps, { _unlit: true } as PbrMaterialProps]) {
            const scene = await buildGpuScene(asset, engine, material, 1);
            const binding = scene._renderables[0]!.bind(engine, SIG);
            flushBinding(binding);
            const pass = createMockRenderPass();
            expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        }
    });

    it("grows the draw-vertex/instance buffers make-before-break across instance counts", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = await buildGpuScene(asset, engine, {} as PbrMaterialProps, 1);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        flushBinding(binding);
        const before = engine._device as unknown as { buffers: { destroyed: boolean }[] };
        const drawBufferCount = before.buffers.filter((b) => (b as { label?: string }).label === "mesh-lod-draw-vertices").length;
        // Add two more instances and re-flush: capacity growth allocates a larger draw buffer.
        for (let i = 0; i < 2; i++) {
            const instance = createMeshLoDInstance(asset, scene._meshLoDRegistry!.batches[0]!.material);
            addMeshLoDInstanceToScene(scene, instance);
        }
        flushBinding(binding);
        const after = before.buffers.filter((b) => (b as { label?: string }).label === "mesh-lod-draw-vertices").length;
        expect(after).toBeGreaterThan(drawBufferCount);
    });

    it("passes an orthographic camera's effective vertical extent to the GPU selection UBO", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "gpu" });
        const scene = await buildGpuScene(asset, engine, {} as PbrMaterialProps, 1);
        const camera = fakeCamera();
        camera.ortho = { halfHeight: 10, top: 3, bottom: -7, left: null, right: null };
        const binding = scene._renderables[0]!.bind(engine, SIG);
        flushBinding(binding, { ...CONTEXT, _camera: camera });
        const packet = scene._meshLoDRegistry!.batches[0]!._packet as { gpuBatchState: { paramsF32: Float32Array } };
        expect(packet.gpuBatchState.paramsF32[31]).toBe(10);
        expect(packet.gpuBatchState.paramsF32[29]).toBe(600);
    });
});
