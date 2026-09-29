/** MeshLoD GPU selection equivalence (Task 5.2) — Node model-vs-oracle comparison.
 *
 *  Node has no WebGPU, so the deterministic `runMeshLoDGpuSelection` model — the
 *  exact TS mirror of `mesh-lod-selection.wgsl`, reading the same packed buffers the
 *  GPU consumes — stands in for the compute path. This spec drives every committed
 *  CPU-oracle fixture through the packed buffers and asserts the GPU model returns
 *  identical selected cluster IDs, desired page order, hysteresis transitions, and
 *  visibility/fallback counts, plus transformed-instance independence and bounded
 *  transient-capacity overflow. The real WGSL is validated in the browser (Task 5.4). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectMeshLoDCpu, type MeshLoDFrustumPlane, type MeshLoDSelectionInput } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
import type { MeshLoDCluster, MeshLoDGroup, MeshLoDHierarchyNode, MeshLoDPageRecord } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
import {
    INSTANCE_WORDS,
    PAGE_FLAG_RESIDENT,
    PAGE_STATE_WORDS,
    createMeshLoDGpuBatchState,
    createMeshLoDGpuInstanceState,
    getMeshLoDUpdateBatch,
    packClusters,
    packGroupPageRefs,
    packGroups,
    packHierarchyNodes,
    packInstanceRecord,
    queueMeshLoDGpuSelection,
    runMeshLoDGpuSelection,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDGpuFrameParams, MeshLoDGpuSelectionModelInput, MeshLoDGpuSelectionParams } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDAssetRuntime } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createMockEngine } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

type V3 = [number, number, number];

interface FixtureHierarchy {
    levelCount: number;
    groupPageRefs: number[];
    pageStoredBytes: number[];
    groups: Array<{
        center: V3;
        radius: number;
        simplifiedError: number;
        depth: number;
        firstCluster: number;
        clusterCount: number;
        firstPageRef: number;
        pageRefCount: number;
        terminal: boolean;
    }>;
    clusters: Array<{ center: V3; radius: number; error: number; groupId: number; refinedGroupId: number; pageId: number; triangleCount: number }>;
    nodes: Array<{ center: V3; radius: number; error: number; groupId: number; childOffset: number; childCount: number }>;
}

interface FixtureCase {
    name: string;
    camera: MeshLoDSelectionInput["camera"];
    frustumPlanes: MeshLoDFrustumPlane[];
    residentPages: number[];
    wasFineRequired: number[];
    screenSpaceError: number;
    lodHysteresis: number;
    expected: { selectedClusterIds: number[]; desiredPageIds: number[]; fineRequired: number[]; fallbackGroupCount: number; visibleGroupCount: number };
}

interface Fixture {
    description: string;
    hierarchy: FixtureHierarchy;
    cases: FixtureCase[];
}

function loadFixture(name: string): Fixture {
    return JSON.parse(readFileSync(fileURLToPath(new URL(`../../unit/mesh-lod/fixtures/${name}`, import.meta.url)), "utf-8")) as Fixture;
}

const toGroup = (g: FixtureHierarchy["groups"][number]): MeshLoDGroup => ({ ...g, pinned: g.terminal, sourceTriangleCount: 0, outputTriangleCount: 0 });
const toCluster = (c: FixtureHierarchy["clusters"][number]): MeshLoDCluster => ({ ...c, vertexOffset: 0, indexOffset: 0, vertexCount: 0, sourceTriangleCount: 0 });
const toNode = (n: FixtureHierarchy["nodes"][number]): MeshLoDHierarchyNode => n;

function toPage(storedBytes: number): MeshLoDPageRecord {
    return {
        offset: 0,
        storedBytes,
        meaningfulBytes: 0,
        decodedBytes: 0,
        crc: 0,
        vertexCount: 0,
        localIndexCount: 0,
        vertexByteOffset: 0,
        indexByteOffset: 0,
        firstCluster: 0,
        clusterCount: 0,
        pinned: false,
        coarse: false,
        minDepth: 0,
        maxDepth: 0,
    };
}

function oracleInput(h: FixtureHierarchy, c: FixtureCase, worldMatrix: readonly number[]): MeshLoDSelectionInput {
    const resident = new Set(c.residentPages);
    return {
        groups: h.groups.map(toGroup),
        clusters: h.clusters.map(toCluster),
        nodes: h.nodes.map(toNode),
        pageRecords: h.pageStoredBytes.map(toPage),
        groupPageRefs: Uint32Array.from(h.groupPageRefs),
        levelCount: h.levelCount,
        worldMatrix,
        camera: c.camera,
        frustumPlanes: c.frustumPlanes,
        screenSpaceError: c.screenSpaceError,
        lodHysteresis: c.lodHysteresis,
        isPageResident: (id) => resident.has(id),
        wasFineRequired: Uint8Array.from(c.wasFineRequired),
    };
}

function packPageState(pageCount: number, resident: Set<number>): Uint32Array {
    const out = new Uint32Array(pageCount * PAGE_STATE_WORDS);
    for (let p = 0; p < pageCount; p++) {
        if (resident.has(p)) {
            out[p * PAGE_STATE_WORDS] = PAGE_FLAG_RESIDENT;
        }
    }
    return out;
}

function modelInput(h: FixtureHierarchy, c: FixtureCase, worldMatrix: readonly number[], maxSelected?: number): MeshLoDGpuSelectionModelInput {
    const groupCount = h.groups.length;
    const wordsPerInstance = Math.max(Math.ceil(groupCount / 32), 1);
    const instances = new Float32Array(INSTANCE_WORDS);
    const instancesU32 = new Uint32Array(instances.buffer);
    packInstanceRecord(instances, instancesU32, 0, worldMatrix, true, 0);
    const priorState = new Uint32Array(wordsPerInstance);
    for (let g = 0; g < groupCount; g++) {
        if (c.wasFineRequired[g]) {
            priorState[g >>> 5]! |= 1 << (g & 31);
        }
    }
    const params: MeshLoDGpuSelectionParams = {
        cameraPos: c.camera.position,
        verticalFov: c.camera.verticalFov,
        near: c.camera.near,
        targetWidth: c.camera.targetWidth,
        targetHeight: c.camera.targetHeight,
        orthographicHeight: c.camera.orthographicHeight,
        frustumPlanes: c.frustumPlanes,
        screenSpaceError: c.screenSpaceError,
        lodHysteresis: c.lodHysteresis,
        levelCount: h.levelCount,
    };
    return {
        nodes: packHierarchyNodes(h.nodes.map(toNode)),
        groups: packGroups(h.groups.map(toGroup)),
        clusters: packClusters(h.clusters.map(toCluster)),
        groupPageRefs: packGroupPageRefs(Uint32Array.from(h.groupPageRefs)),
        pageState: packPageState(h.pageStoredBytes.length, new Set(c.residentPages)),
        pageStoredBytes: h.pageStoredBytes,
        instances,
        instancesU32,
        priorState,
        instanceCount: 1,
        nodeCount: h.nodes.length,
        groupCount,
        clusterCount: h.clusters.length,
        pageCount: h.pageStoredBytes.length,
        wordsPerInstance,
        params,
        maxSelected,
    };
}

function fineRequiredFromPrior(prior: Uint32Array, groupCount: number): number[] {
    const out: number[] = [];
    for (let g = 0; g < groupCount; g++) {
        out.push((prior[g >>> 5]! & (1 << (g & 31))) !== 0 ? 1 : 0);
    }
    return out;
}

for (const fixtureName of ["selection-lod.json", "selection-frustum.json", "selection-orthographic.json"]) {
    const fixture = loadFixture(fixtureName);
    describe(`GPU selection model ≡ CPU oracle — ${fixtureName}`, () => {
        for (const testCase of fixture.cases) {
            it(testCase.name, () => {
                const oracle = selectMeshLoDCpu(oracleInput(fixture.hierarchy, testCase, IDENTITY));
                const input = modelInput(fixture.hierarchy, testCase, IDENTITY);
                const model = runMeshLoDGpuSelection(input);

                const modelClusterIds = [...new Set(model.selected.map((p) => p.clusterId))].sort((a, b) => a - b);
                expect(modelClusterIds).toEqual(Array.from(oracle.selectedClusterIds));
                expect(model.desiredPages.map((p) => p.pageId)).toEqual(oracle.desiredPages.map((p) => p.pageId));
                expect(fineRequiredFromPrior(input.priorState, fixture.hierarchy.groups.length)).toEqual(Array.from(oracle.fineRequired));
                expect(model.fallbackGroupCount).toBe(oracle.fallbackGroupCount);
                expect(model.visibleGroupCount).toBe(oracle.visibleGroupCount);
                expect(model.renderedTriangleCount).toBe(oracle.renderedTriangleCount);
                // Desired page priorities agree with the oracle within float tolerance.
                for (let i = 0; i < oracle.desiredPages.length; i++) {
                    expect(model.desiredPages[i]!.priority).toBeCloseTo(oracle.desiredPages[i]!.priority, 5);
                }
            });
        }
    });
}

describe("GPU selection model — transformed instances", () => {
    const fixture = loadFixture("selection-lod.json");
    const closeCase = fixture.cases.find((c) => c.name.startsWith("close-resident"))!;

    it("selects fine near and coarse far, matching the oracle per instance", () => {
        const farMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 4990, 1];
        for (const world of [IDENTITY, farMatrix]) {
            const oracle = selectMeshLoDCpu(oracleInput(fixture.hierarchy, closeCase, world));
            const model = runMeshLoDGpuSelection(modelInput(fixture.hierarchy, closeCase, world));
            const ids = [...new Set(model.selected.map((p) => p.clusterId))].sort((a, b) => a - b);
            expect(ids).toEqual(Array.from(oracle.selectedClusterIds));
        }
    });

    it("keeps two instances' selections independent in one batch", () => {
        const h = fixture.hierarchy;
        const groupCount = h.groups.length;
        const wordsPerInstance = Math.max(Math.ceil(groupCount / 32), 1);
        const instances = new Float32Array(2 * INSTANCE_WORDS);
        const instancesU32 = new Uint32Array(instances.buffer);
        packInstanceRecord(instances, instancesU32, 0, IDENTITY, true, 10); // near
        packInstanceRecord(instances, instancesU32, INSTANCE_WORDS, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 4990, 1], true, 11); // far
        const base = modelInput(h, closeCase, IDENTITY);
        const model = runMeshLoDGpuSelection({ ...base, instances, instancesU32, priorState: new Uint32Array(2 * wordsPerInstance), instanceCount: 2 });
        const near = model.selected
            .filter((p) => p.instanceId === 0)
            .map((p) => p.clusterId)
            .sort((a, b) => a - b);
        const far = model.selected
            .filter((p) => p.instanceId === 1)
            .map((p) => p.clusterId)
            .sort((a, b) => a - b);
        expect(near).toEqual([2, 3]); // fine (slot 0)
        expect(far).toEqual([0, 1]); // coarse
    });

    it("skips an invisible instance entirely", () => {
        const h = fixture.hierarchy;
        const instances = new Float32Array(INSTANCE_WORDS);
        const instancesU32 = new Uint32Array(instances.buffer);
        packInstanceRecord(instances, instancesU32, 0, IDENTITY, false, 5); // invisible
        const model = runMeshLoDGpuSelection({ ...modelInput(h, closeCase, IDENTITY), instances, instancesU32 });
        expect(model.selected).toHaveLength(0);
        expect(model.visibleGroupCount).toBe(0);
    });
});

describe("GPU selection model — bounded transient capacity", () => {
    const fixture = loadFixture("selection-lod.json");
    const closeCase = fixture.cases.find((c) => c.name.startsWith("close-resident"))!;

    it("flags overflow without exceeding the selected-list capacity", () => {
        const model = runMeshLoDGpuSelection(modelInput(fixture.hierarchy, closeCase, IDENTITY, 1));
        expect(model.overflow).toBe(true);
        expect(model.selected.length).toBeLessThanOrEqual(1);
    });

    it("does not overflow when capacity is sufficient", () => {
        const model = runMeshLoDGpuSelection(modelInput(fixture.hierarchy, closeCase, IDENTITY, 64));
        expect(model.overflow).toBe(false);
    });
});

function fakeRuntime(h: FixtureHierarchy): MeshLoDAssetRuntime {
    const pages = h.pageStoredBytes.map((_, id) => ({
        id,
        state: "gpu-resident" as const,
        arenaOffset: id * 65536,
        arenaBytes: 65536,
        vertexByteOffset: 0,
        indices: null,
        lastUsedFrame: 0,
        priority: 0,
        frameRefCount: 0,
    }));
    return {
        hierarchyNodes: h.nodes.map(toNode),
        groups: h.groups.map(toGroup),
        clusters: h.clusters.map(toCluster),
        groupPageRefs: Uint32Array.from(h.groupPageRefs),
        pageRecords: h.pageStoredBytes.map(toPage),
        generation: 1,
        gpuSelection: null,
        gpu: { pages, residentPageCount: pages.length, arena: { buffer: {} as GPUBuffer } },
    } as unknown as MeshLoDAssetRuntime;
}

describe("GPU selection orchestration (mock device)", () => {
    const fixture = loadFixture("selection-lod.json");
    const frame: MeshLoDGpuFrameParams = {
        cameraPos: [0, 0, 5],
        verticalFov: 1.0,
        near: 0.1,
        targetWidth: 1000,
        targetHeight: 1000,
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        frustumCull: false,
        screenSpaceError: 2.0,
        lodHysteresis: 0.15,
        levelCount: fixture.hierarchy.levelCount,
    };
    const instance = { worldMatrix: IDENTITY, worldMatrixVersion: 1, visible: true, _instanceId: 0 };

    it("submits one compute pass with selection + expansion dispatches and resets", () => {
        const { engine, encoder } = createMockEngine();
        const runtime = fakeRuntime(fixture.hierarchy);
        const instanceState = createMeshLoDGpuInstanceState(fixture.hierarchy.groups.length);
        const batchState = createMeshLoDGpuBatchState();
        const updateBatch = getMeshLoDUpdateBatch({} as RenderTargetSignature);
        updateBatch.reset();
        const handles = queueMeshLoDGpuSelection(engine, updateBatch, runtime, instanceState, batchState, [instance], 12, frame);
        expect(handles).not.toBeNull();
        expect(handles!.selectedBuffer).toBeTruthy();
        expect(handles!.controlBuffer).toBeTruthy();
        expect(handles!.drawVertexBuffer).toBeTruthy();
        expect(handles!.drawArgsBuffer).toBeTruthy();
        updateBatch.flush(engine);
        // Two compute passes: selection (traverse→evaluate→select→demand→clamp = 5 direct)
        // then expansion (expandClusters indirect + finalizeDraw direct = 2); 5 resets.
        expect(encoder.computePasses).toHaveLength(2);
        expect(encoder.computePasses[0]!.dispatches).toHaveLength(5);
        expect(encoder.computePasses[0]!.dispatches.every((d) => d.kind === "direct")).toBe(true);
        expect(encoder.computePasses[1]!.dispatches).toHaveLength(2);
        expect(encoder.computePasses[1]!.dispatches[0]!.kind).toBe("indirect");
        expect(encoder.computePasses[1]!.dispatches[1]!.kind).toBe("direct");
        expect(encoder.clears.length).toBe(5);
    });

    it("returns null and queues nothing for an empty batch", () => {
        const { engine, encoder } = createMockEngine();
        const runtime = fakeRuntime(fixture.hierarchy);
        const instanceState = createMeshLoDGpuInstanceState(fixture.hierarchy.groups.length);
        const batchState = createMeshLoDGpuBatchState();
        const updateBatch = getMeshLoDUpdateBatch({} as RenderTargetSignature);
        updateBatch.reset();
        expect(queueMeshLoDGpuSelection(engine, updateBatch, runtime, instanceState, batchState, [], 12, frame)).toBeNull();
        updateBatch.flush(engine);
        expect(encoder.computePasses).toHaveLength(0);
    });
});
