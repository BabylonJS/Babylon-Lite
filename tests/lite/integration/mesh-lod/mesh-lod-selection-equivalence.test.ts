/** MeshLoD CPU/GPU selection equivalence (Task 5.4) — REQ-SEL-2, REQ-VERIFY-3.
 *
 *  The GPU selection model (`runMeshLoDGpuSelection`, the exact TS mirror of the
 *  selection WGSL over the packed GPU buffers) is accepted only after it reproduces
 *  the CPU oracle's decisions. Task 5.2's spec covers the base perspective/frustum/
 *  orthographic fixtures; this spec adds the remaining REQ-VERIFY-3 scenarios that a
 *  single-shot fixture can't express: a jittered hysteresis sequence that threads prior
 *  fine-required state through both selectors, two independently transformed instances
 *  selected in one batch, a frustum-tangent boundary, and incomplete-residency page
 *  demand order + priority. The real WGSL is validated pixel-for-pixel in the browser
 *  (a MAD-0 GPU-vs-CPU statue render, recorded on the Task 5.3 board entry). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    selectMeshLoDCpu,
    normalizeMeshLoDSelectedClusterIds,
    type MeshLoDCamera,
    type MeshLoDFrustumPlane,
    type MeshLoDSelectionInput,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
import type { MeshLoDCluster, MeshLoDGroup, MeshLoDHierarchyNode, MeshLoDPageRecord } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
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
import type { MeshLoDGpuSelectionModelInput, MeshLoDGpuSelectionParams } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";

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
    clusters: Array<{
        center: V3;
        radius: number;
        error: number;
        groupId: number;
        refinedGroupId: number;
        pageId: number;
        triangleCount: number;
        normalCone?: [number, number, number, number];
    }>;
    nodes: Array<{ center: V3; radius: number; error: number; groupId: number; childOffset: number; childCount: number }>;
}

const load = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../unit/mesh-lod/fixtures/${name}`, import.meta.url)), "utf-8"));
const toGroup = (g: FixtureHierarchy["groups"][number]): MeshLoDGroup => ({ ...g, pinned: g.terminal, sourceTriangleCount: 0, outputTriangleCount: 0 });
const toCluster = (c: FixtureHierarchy["clusters"][number]): MeshLoDCluster => ({
    ...c,
    normalCone: c.normalCone ?? null,
    vertexOffset: 0,
    indexOffset: 0,
    vertexCount: 0,
    sourceTriangleCount: 0,
});

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

function packPageState(pageCount: number, resident: Set<number>): Uint32Array {
    const out = new Uint32Array(pageCount * PAGE_STATE_WORDS);
    for (let p = 0; p < pageCount; p++) {
        if (resident.has(p)) {
            out[p * PAGE_STATE_WORDS] = PAGE_FLAG_RESIDENT;
        }
    }
    return out;
}

interface Scenario {
    camera: MeshLoDCamera;
    frustumPlanes: MeshLoDFrustumPlane[];
    resident: number[];
    wasFineRequired: number[];
    screenSpaceError: number;
    lodHysteresis: number;
    world?: readonly number[];
}

function oracleInput(h: FixtureHierarchy, s: Scenario): MeshLoDSelectionInput {
    const resident = new Set(s.resident);
    return {
        groups: h.groups.map(toGroup),
        clusters: h.clusters.map(toCluster),
        nodes: h.nodes.map((n) => n as MeshLoDHierarchyNode),
        pageRecords: h.pageStoredBytes.map(toPage),
        groupPageRefs: Uint32Array.from(h.groupPageRefs),
        levelCount: h.levelCount,
        worldMatrix: s.world ?? IDENTITY,
        camera: s.camera,
        frustumPlanes: s.frustumPlanes,
        screenSpaceError: s.screenSpaceError,
        lodHysteresis: s.lodHysteresis,
        isPageResident: (id) => resident.has(id),
        wasFineRequired: Uint8Array.from(s.wasFineRequired),
    };
}

function modelParams(s: Scenario, levelCount: number): MeshLoDGpuSelectionParams {
    return {
        cameraPos: s.camera.position,
        verticalFov: s.camera.verticalFov,
        near: s.camera.near,
        targetWidth: s.camera.targetWidth,
        targetHeight: s.camera.targetHeight,
        orthographicHeight: s.camera.orthographicHeight,
        frustumPlanes: s.frustumPlanes,
        screenSpaceError: s.screenSpaceError,
        lodHysteresis: s.lodHysteresis,
        levelCount,
    };
}

/** Build a model input with one instance from a scenario + prior-state bitset. */
function modelInput(h: FixtureHierarchy, s: Scenario, prior: Uint32Array): MeshLoDGpuSelectionModelInput {
    const groupCount = h.groups.length;
    const wordsPerInstance = Math.max(Math.ceil(groupCount / 32), 1);
    const instances = new Float32Array(INSTANCE_WORDS);
    const instancesU32 = new Uint32Array(instances.buffer);
    packInstanceRecord(instances, instancesU32, 0, s.world ?? IDENTITY, true, 0);
    return {
        nodes: packHierarchyNodes(h.nodes.map((n) => n as MeshLoDHierarchyNode)),
        groups: packGroups(h.groups.map(toGroup)),
        clusters: packClusters(h.clusters.map(toCluster)),
        groupPageRefs: packGroupPageRefs(Uint32Array.from(h.groupPageRefs)),
        pageState: packPageState(h.pageStoredBytes.length, new Set(s.resident)),
        pageStoredBytes: h.pageStoredBytes,
        instances,
        instancesU32,
        priorState: prior,
        instanceCount: 1,
        nodeCount: h.nodes.length,
        groupCount,
        clusterCount: h.clusters.length,
        pageCount: h.pageStoredBytes.length,
        wordsPerInstance,
        params: modelParams(s, h.levelCount),
    };
}

const sortedUnique = (ids: { clusterId: number; instanceId: number }[]): number[] => Array.from(normalizeMeshLoDSelectedClusterIds(ids));
const fineFromPrior = (prior: Uint32Array, groupCount: number): number[] => Array.from({ length: groupCount }, (_, g) => ((prior[g >>> 5]! & (1 << (g & 31))) !== 0 ? 1 : 0));

describe("MeshLoD selection equivalence — jittered hysteresis sequence", () => {
    const fixture = load("selection-jitter.json") as {
        hierarchy: FixtureHierarchy;
        jitter: { name: string; position: V3 }[];
        residentPages: number[];
        screenSpaceError: number;
        lodHysteresis: number;
    };
    const h = fixture.hierarchy;
    const camera = (position: V3): MeshLoDCamera => ({ position, verticalFov: 1.0, near: 0.1, targetWidth: 1000, targetHeight: 1000 });

    it("threads prior state through the sequence with GPU model matching the CPU oracle at every step", () => {
        // Independent prior-state carriers for each selector, advanced in lockstep.
        const oraclePrior = new Uint8Array(h.groups.length);
        const modelPrior = new Uint32Array(Math.max(Math.ceil(h.groups.length / 32), 1));
        let lastCut: number[] | null = null;
        for (const step of fixture.jitter) {
            const scenario: Scenario = {
                camera: camera(step.position),
                frustumPlanes: [],
                resident: fixture.residentPages,
                wasFineRequired: Array.from(oraclePrior),
                screenSpaceError: fixture.screenSpaceError,
                lodHysteresis: fixture.lodHysteresis,
            };
            const oracle = selectMeshLoDCpu(oracleInput(h, scenario));
            const model = runMeshLoDGpuSelection(modelInput(h, scenario, modelPrior));
            expect(sortedUnique(model.selected), step.name).toEqual(Array.from(oracle.selectedClusterIds));
            expect(fineFromPrior(modelPrior, h.groups.length), step.name).toEqual(Array.from(oracle.fineRequired));
            oraclePrior.set(oracle.fineRequired);
            lastCut = Array.from(oracle.selectedClusterIds);
        }
        expect(lastCut).toEqual([2, 3]); // sequence ends close → refined
    });

    it("holds the fine cut across in-band jitter (no oscillation once settled)", () => {
        const modelPrior = new Uint32Array(1);
        // Settle fine up close.
        runMeshLoDGpuSelection(
            modelInput(
                h,
                { camera: camera([0, 0, 5]), frustumPlanes: [], resident: fixture.residentPages, wasFineRequired: [0, 0], screenSpaceError: 2.0, lodHysteresis: 0.15 },
                modelPrior
            )
        );
        // Every in-band jitter keeps the fine cut.
        for (const z of [2288, 2360, 2210, 2300, 2288]) {
            const model = runMeshLoDGpuSelection(
                modelInput(
                    h,
                    { camera: camera([0, 0, z]), frustumPlanes: [], resident: fixture.residentPages, wasFineRequired: [0, 0], screenSpaceError: 2.0, lodHysteresis: 0.15 },
                    modelPrior
                )
            );
            expect(sortedUnique(model.selected), `z=${z}`).toEqual([2, 3]);
        }
    });
});

describe("MeshLoD selection equivalence — two transformed instances in one batch", () => {
    const h = (load("selection-lod.json") as { hierarchy: FixtureHierarchy }).hierarchy;
    const near = IDENTITY;
    const far = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 4990, 1];
    const scenario = (world: readonly number[]): Scenario => ({
        camera: { position: [0, 0, 5], verticalFov: 1.0, near: 0.1, targetWidth: 1000, targetHeight: 1000 },
        frustumPlanes: [],
        resident: [0, 1],
        wasFineRequired: [0, 0],
        screenSpaceError: 2.0,
        lodHysteresis: 0.15,
        world,
    });

    it("selects each instance independently, matching a per-instance oracle run", () => {
        const groupCount = h.groups.length;
        const wordsPerInstance = Math.max(Math.ceil(groupCount / 32), 1);
        const instances = new Float32Array(2 * INSTANCE_WORDS);
        const instancesU32 = new Uint32Array(instances.buffer);
        packInstanceRecord(instances, instancesU32, 0, near, true, 0);
        packInstanceRecord(instances, instancesU32, INSTANCE_WORDS, far, true, 1);
        const base = modelInput(h, scenario(near), new Uint32Array(2 * wordsPerInstance));
        const model = runMeshLoDGpuSelection({ ...base, instances, instancesU32, priorState: new Uint32Array(2 * wordsPerInstance), instanceCount: 2 });

        const oracleNear = selectMeshLoDCpu(oracleInput(h, scenario(near)));
        const oracleFar = selectMeshLoDCpu(oracleInput(h, scenario(far)));
        const modelNear = Array.from(normalizeMeshLoDSelectedClusterIds(model.selected, 0));
        const modelFar = Array.from(normalizeMeshLoDSelectedClusterIds(model.selected, 1));
        expect(modelNear).toEqual(Array.from(oracleNear.selectedClusterIds));
        expect(modelFar).toEqual(Array.from(oracleFar.selectedClusterIds));
        expect(modelNear).not.toEqual(modelFar); // genuinely different cuts
    });
});

describe("MeshLoD selection equivalence — frustum boundary + incomplete residency", () => {
    const h = (load("selection-lod.json") as { hierarchy: FixtureHierarchy }).hierarchy;
    const cam: MeshLoDCamera = { position: [0, 0, 5], verticalFov: 1.0, near: 0.1, targetWidth: 1000, targetHeight: 1000 };

    it("keeps a cluster whose sphere is exactly tangent to a frustum plane (boundary is visible)", () => {
        // Group/cluster spheres have radius 1 at the origin. Plane x + 1 >= 0 with the
        // instance translated to x = -2 makes the signed distance exactly -radius.
        const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1];
        const s: Scenario = { camera: cam, frustumPlanes: [[1, 0, 0, 1]], resident: [0, 1], wasFineRequired: [0, 0], screenSpaceError: 2.0, lodHysteresis: 0.15, world };
        const oracle = selectMeshLoDCpu(oracleInput(h, s));
        const model = runMeshLoDGpuSelection(modelInput(h, s, new Uint32Array(1)));
        expect(sortedUnique(model.selected)).toEqual(Array.from(oracle.selectedClusterIds));
        expect(oracle.visibleGroupCount).toBeGreaterThan(0); // tangent sphere is not culled
    });

    describe("MeshLoD selection equivalence — meshlet normal cones", () => {
        const source = (load("selection-lod.json") as { hierarchy: FixtureHierarchy }).hierarchy;
        const h: FixtureHierarchy = {
            ...source,
            clusters: source.clusters.map((cluster, index) => ({
                ...cluster,
                normalCone: index === 2 ? [0, 0, 1, 0.2] : index === 3 ? [0, 0, -1, 0.2] : undefined,
            })),
        };

        it("culls the backfacing fine meshlet and keeps the frontfacing meshlet in both selectors", () => {
            const scenario: Scenario = {
                camera: { position: [0, 0, -5], verticalFov: 1.0, near: 0.1, targetWidth: 1000, targetHeight: 1000 },
                frustumPlanes: [],
                resident: [0, 1],
                wasFineRequired: [0, 0],
                screenSpaceError: 2.0,
                lodHysteresis: 0.15,
            };
            const oracle = selectMeshLoDCpu(oracleInput(h, scenario));
            const model = runMeshLoDGpuSelection(modelInput(h, scenario, new Uint32Array(1)));

            expect(Array.from(oracle.selectedClusterIds)).toEqual([3]);
            expect(sortedUnique(model.selected)).toEqual([3]);
        });
    });

    it("keeps every cluster in a visible selected group when cluster bounds disagree", () => {
        const mismatched: FixtureHierarchy = {
            ...h,
            clusters: h.clusters.map((cluster) => ({ ...cluster, center: [-100, 0, 0], radius: 0.01 })),
        };
        const s: Scenario = {
            camera: cam,
            frustumPlanes: [[1, 0, 0, 1]],
            resident: [0, 1],
            wasFineRequired: [0, 0],
            screenSpaceError: 2.0,
            lodHysteresis: 0.15,
        };
        const oracle = selectMeshLoDCpu(oracleInput(mismatched, s));
        const model = runMeshLoDGpuSelection(modelInput(mismatched, s, new Uint32Array(1)));
        expect(Array.from(oracle.selectedClusterIds)).toEqual([2, 3]);
        expect(sortedUnique(model.selected)).toEqual([2, 3]);
    });

    it("culls a group pushed just outside the plane, in both selectors", () => {
        const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2.01, 0, 0, 1];
        const s: Scenario = { camera: cam, frustumPlanes: [[1, 0, 0, 1]], resident: [0, 1], wasFineRequired: [0, 0], screenSpaceError: 2.0, lodHysteresis: 0.15, world };
        const oracle = selectMeshLoDCpu(oracleInput(h, s));
        const model = runMeshLoDGpuSelection(modelInput(h, s, new Uint32Array(1)));
        expect(sortedUnique(model.selected)).toEqual(Array.from(oracle.selectedClusterIds));
        expect(model.visibleGroupCount).toBe(oracle.visibleGroupCount);
    });

    it("matches page demand order and priority when the finer group's page is missing", () => {
        // Close camera wants the fine group; its page (1) is not resident → coarse fallback + demand.
        const s: Scenario = { camera: cam, frustumPlanes: [], resident: [0], wasFineRequired: [0, 0], screenSpaceError: 2.0, lodHysteresis: 0.15 };
        const oracle = selectMeshLoDCpu(oracleInput(h, s));
        const model = runMeshLoDGpuSelection(modelInput(h, s, new Uint32Array(1)));
        expect(sortedUnique(model.selected)).toEqual(Array.from(oracle.selectedClusterIds));
        expect(model.desiredPages.map((p) => p.pageId)).toEqual(oracle.desiredPages.map((p) => p.pageId));
        expect(model.fallbackGroupCount).toBe(oracle.fallbackGroupCount);
        for (let i = 0; i < oracle.desiredPages.length; i++) {
            expect(model.desiredPages[i]!.priority).toBeCloseTo(oracle.desiredPages[i]!.priority, 5);
        }
    });
});
