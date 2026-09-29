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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance, setMeshLoDSelectionMode } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { selectMeshLoDCpu } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
import {
    INSTANCE_WORDS,
    PAGE_FLAG_RESIDENT,
    PAGE_STATE_WORDS,
    packClusters,
    packGroupPageRefs,
    packGroups,
    packHierarchyNodes,
    packInstanceRecord,
    runMeshLoDGpuSelection,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { MeshLoDAssetRuntime } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import type { DrawUpdateBatch } from "../../../../packages/babylon-lite/src/render/renderable.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

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
