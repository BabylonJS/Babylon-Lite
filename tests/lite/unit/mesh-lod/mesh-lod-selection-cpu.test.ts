/** MeshLoD CPU selection oracle tests.
 *
 *  Fixture-driven cases (committed expected cluster ids) cover the crack-free
 *  group-DAG cut, residency fallback + page demand, the far/coarse case, exact
 *  hysteresis-band behavior, frustum culling, and orthographic projection. An
 *  extra block proves two instances of one hierarchy select independently under
 *  different world transforms. The oracle is imported through the internal
 *  `mesh-lod-testing` subpath module. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectMeshLoDCpu, type MeshLoDFrustumPlane, type MeshLoDSelectionInput } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";
import type { MeshLoDCluster, MeshLoDGroup, MeshLoDHierarchyNode, MeshLoDPageRecord } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";

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
    return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8")) as Fixture;
}

function toGroup(g: FixtureHierarchy["groups"][number]): MeshLoDGroup {
    return { ...g, pinned: g.terminal, sourceTriangleCount: 0, outputTriangleCount: 0 };
}

function toCluster(c: FixtureHierarchy["clusters"][number]): MeshLoDCluster {
    return { ...c, vertexOffset: 0, indexOffset: 0, vertexCount: 0, sourceTriangleCount: 0 };
}

function toNode(n: FixtureHierarchy["nodes"][number]): MeshLoDHierarchyNode {
    return n;
}

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

function buildInput(h: FixtureHierarchy, c: FixtureCase, worldMatrix: readonly number[] = IDENTITY): MeshLoDSelectionInput {
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

for (const fixtureName of ["selection-lod.json", "selection-frustum.json", "selection-orthographic.json"]) {
    const fixture = loadFixture(fixtureName);
    describe(`selectMeshLoDCpu — ${fixtureName}`, () => {
        for (const testCase of fixture.cases) {
            it(testCase.name, () => {
                const result = selectMeshLoDCpu(buildInput(fixture.hierarchy, testCase));
                expect(Array.from(result.selectedClusterIds)).toEqual(testCase.expected.selectedClusterIds);
                expect(result.desiredPages.map((p) => p.pageId)).toEqual(testCase.expected.desiredPageIds);
                expect(Array.from(result.fineRequired)).toEqual(testCase.expected.fineRequired);
                expect(result.fallbackGroupCount).toBe(testCase.expected.fallbackGroupCount);
                expect(result.visibleGroupCount).toBe(testCase.expected.visibleGroupCount);
            });
        }
    });
}

describe("selectMeshLoDCpu — instance transforms", () => {
    const fixture = loadFixture("selection-lod.json");
    const closeCase = fixture.cases.find((c) => c.name.startsWith("close-resident"))!;

    it("selects fine for a near instance and coarse for a distant instance of the same hierarchy", () => {
        const near = selectMeshLoDCpu(buildInput(fixture.hierarchy, closeCase, IDENTITY));
        // Translate the instance far down +Z (column-major translation in m[12..14]).
        const farMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 4990, 1];
        const far = selectMeshLoDCpu(buildInput(fixture.hierarchy, closeCase, farMatrix));
        expect(Array.from(near.selectedClusterIds)).toEqual([2, 3]);
        expect(Array.from(far.selectedClusterIds)).toEqual([0, 1]);
    });

    it("applies world scale to error so a scaled-up distant instance still refines", () => {
        // Uniform 1000x scale multiplies world error by the max column length.
        const scaled = [1000, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 1000, 0, 0, 0, 4990, 1];
        const result = selectMeshLoDCpu(buildInput(fixture.hierarchy, closeCase, scaled));
        expect(Array.from(result.selectedClusterIds)).toEqual([2, 3]);
    });
});
