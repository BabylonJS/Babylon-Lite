/** MeshLoD `.mlod` parser/validator unit tests.
 *
 *  Three layers:
 *   1. A byte-exact minimal container built in TS parses to the expected records.
 *   2. The committed statue assets (real native-converter output) parse and match
 *      their recorded statistics — proving the TS reader agrees with the C++
 *      writer, including CRC32C.
 *   3. A mutation matrix confirms every malformed/corrupt/incompatible input fails
 *      with its stable error code and never yields a container. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    PAGE_MAX_BYTES,
    PAGE_TABLE_RECORD_SIZE,
    SECTION_PAGE_TABLE,
    parseMeshLoDContainer,
    toMeshLoDMetadata,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-format.js";
import { isMeshLoDError, type MeshLoDErrorCode } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import { buildMinimalContainer, resealContainer, type FixtureLayout } from "./fixtures/mlod-fixture.js";

describe("parseMeshLoDContainer — minimal valid container", () => {
    it("parses exact metadata and records", () => {
        const { bytes } = buildMinimalContainer();
        const parsed = parseMeshLoDContainer(bytes);

        expect(parsed.header.formatMajor).toBe(1);
        expect(parsed.header.formatMinor).toBe(0);
        expect(parsed.header.clusterCount).toBe(2);
        expect(parsed.header.groupCount).toBe(1);
        expect(parsed.header.hierarchyNodeCount).toBe(1);
        expect(parsed.header.pageCount).toBe(1);
        expect(parsed.header.pinnedPageCount).toBe(1);
        expect(parsed.header.levelCount).toBe(1);
        expect(parsed.header.vertexStride).toBe(24);
        expect(parsed.header.boundsMin).toEqual([-1, -1, -1]);
        expect(parsed.header.boundsMax).toEqual([1, 1, 1]);

        expect(parsed.groups).toHaveLength(1);
        expect(parsed.groups[0]!.terminal).toBe(true);
        expect(parsed.groups[0]!.pinned).toBe(true);
        expect(parsed.groups[0]!.clusterCount).toBe(2);

        expect(parsed.clusters).toHaveLength(2);
        expect(parsed.clusters[0]!.refinedGroupId).toBe(-1);
        expect(parsed.clusters[1]!.vertexOffset).toBe(3);

        expect(parsed.hierarchyNodes).toHaveLength(1);
        expect(parsed.hierarchyNodes[0]!.groupId).toBe(0);
        expect(parsed.hierarchyNodes[0]!.childCount).toBe(0);

        expect(Array.from(parsed.groupPageRefs)).toEqual([0]);

        expect(parsed.pageRecords).toHaveLength(1);
        expect(parsed.pageRecords[0]!.pinned).toBe(true);
        expect(parsed.pageRecords[0]!.coarse).toBe(true);
        expect(parsed.pageRecords[0]!.clusterCount).toBe(2);

        expect(parsed.provenance.toolVersion).toBe("1.0.0-test");
        expect(parsed.provenance.meshoptimizerRevision).toBe("meshopt-rev");
        expect(parsed.provenance.cgltfRevision).toBe("cgltf-rev");
    });

    it("builds public metadata", () => {
        const { bytes } = buildMinimalContainer();
        const metadata = toMeshLoDMetadata(parseMeshLoDContainer(bytes));
        expect(metadata.hierarchyDepth).toBe(1);
        expect(metadata.clusterCount).toBe(2);
        expect(metadata.toolVersion).toBe("1.0.0-test");
        expect(metadata.boundsMax).toEqual([1, 1, 1]);
    });
});

interface StatueStat {
    boundsMax: [number, number, number];
    boundsMin: [number, number, number];
    clusterCount: number;
    groupCount: number;
    hierarchyLevels: number;
    meshIndex: number;
    nodeCount: number;
    pageCount: number;
    pinnedPageCount: number;
    sourceTriangleCount: number;
    totalClusterTriangles: number;
}

describe("parseMeshLoDContainer — committed statue assets", () => {
    const statsPath = fileURLToPath(new URL("../../../../lab/public/mesh-lod/statue-stats.json", import.meta.url));
    const stats = JSON.parse(readFileSync(statsPath, "utf-8")) as { outputs: StatueStat[] };

    for (const stat of stats.outputs) {
        it(`parses statue mesh${String(stat.meshIndex).padStart(3, "0")} and matches recorded stats`, () => {
            const assetPath = fileURLToPath(
                new URL(`../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh${String(stat.meshIndex).padStart(3, "0")}.prim000.mlod`, import.meta.url)
            );
            const bytes = new Uint8Array(readFileSync(assetPath));
            const parsed = parseMeshLoDContainer(bytes);

            expect(parsed.header.meshIndex).toBe(stat.meshIndex);
            expect(parsed.header.clusterCount).toBe(stat.clusterCount);
            expect(parsed.header.groupCount).toBe(stat.groupCount);
            expect(parsed.header.hierarchyNodeCount).toBe(stat.nodeCount);
            expect(parsed.header.pageCount).toBe(stat.pageCount);
            expect(parsed.header.pinnedPageCount).toBe(stat.pinnedPageCount);
            expect(parsed.header.levelCount).toBe(stat.hierarchyLevels);
            expect(parsed.header.sourceTriangleCount).toBe(stat.sourceTriangleCount);
            expect(parsed.header.hierarchyTriangleCount).toBe(stat.totalClusterTriangles);
            expect(parsed.header.boundsMin[0]).toBeCloseTo(stat.boundsMin[0], 4);
            expect(parsed.header.boundsMax[2]).toBeCloseTo(stat.boundsMax[2], 4);

            expect(parsed.groups).toHaveLength(stat.groupCount);
            expect(parsed.clusters).toHaveLength(stat.clusterCount);
            expect(parsed.hierarchyNodes).toHaveLength(stat.nodeCount);
            expect(parsed.pageRecords).toHaveLength(stat.pageCount);
            expect(parsed.pageRecords[0]!.pinned).toBe(true);

            expect(parsed.provenance.toolVersion.length).toBeGreaterThan(0);
            expect(parsed.provenance.meshoptimizerRevision.length).toBeGreaterThan(0);
            expect(parsed.provenance.cgltfRevision.length).toBeGreaterThan(0);
        });
    }
});

describe("parseMeshLoDContainer — mutation matrix", () => {
    function expectParseError(mutate: (bytes: Uint8Array, layout: FixtureLayout) => Uint8Array | void, code: MeshLoDErrorCode): void {
        const { bytes, layout } = buildMinimalContainer();
        const target = mutate(bytes, layout) ?? bytes;
        let threw: unknown;
        try {
            parseMeshLoDContainer(target);
        } catch (error) {
            threw = error;
        }
        expect(isMeshLoDError(threw)).toBe(true);
        expect(isMeshLoDError(threw) && threw.code).toBe(code);
    }

    const dv = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    function twoNodeHierarchy(bytes: Uint8Array, layout: FixtureLayout): void {
        const view = dv(bytes);
        const nodeEntry = layout.directoryOffset + 3 * 64;
        view.setUint32(176, 2, true); // node count in header
        view.setBigUint64(nodeEntry + 16, 64n, true); // section stored bytes
        view.setBigUint64(nodeEntry + 24, 64n, true); // section decoded bytes
        view.setUint32(nodeEntry + 32, 2, true); // section element count
        view.setInt32(layout.nodeOffset + 20, -1, true); // root is an internal node
        view.setUint32(layout.nodeOffset + 24, 1, true); // its child is node 1
        view.setUint32(layout.nodeOffset + 28, 1, true);
        bytes.set(bytes.subarray(layout.nodeOffset, layout.nodeOffset + 20), layout.nodeOffset + 32);
        view.setInt32(layout.nodeOffset + 32 + 20, 0, true); // node 1 is the leaf
    }

    it("accepts a reachable internal node and leaf", () => {
        const { bytes, layout } = buildMinimalContainer();
        twoNodeHierarchy(bytes, layout);
        resealContainer(bytes);
        expect(parseMeshLoDContainer(bytes).hierarchyNodes).toHaveLength(2);
    });

    it("accepts one hierarchy root per level", () => {
        const { bytes, layout } = buildMinimalContainer();
        twoNodeHierarchy(bytes, layout);
        const view = dv(bytes);
        view.setUint32(188, 2, true);
        view.setInt32(layout.nodeOffset + 20, 0, true);
        view.setUint32(layout.nodeOffset + 28, 0, true);
        resealContainer(bytes);
        expect(parseMeshLoDContainer(bytes).hierarchyNodes).toHaveLength(2);
    });

    it("rejects a CRC-correct hierarchy cycle", () =>
        expectParseError((b, layout) => {
            twoNodeHierarchy(b, layout);
            dv(b).setInt32(layout.nodeOffset + 32 + 20, -1, true);
            dv(b).setUint32(layout.nodeOffset + 32 + 24, 0, true);
            dv(b).setUint32(layout.nodeOffset + 32 + 28, 1, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("rejects a CRC-correct unreachable node", () =>
        expectParseError((b, layout) => {
            twoNodeHierarchy(b, layout);
            dv(b).setInt32(layout.nodeOffset + 20, 0, true);
            dv(b).setUint32(layout.nodeOffset + 28, 0, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("bad magic", () => expectParseError((b) => void (b[0] = 0x58), "MLOD_BAD_MAGIC"));

    it("unsupported format major", () => expectParseError((b) => dv(b).setUint16(8, 2, true), "MLOD_UNSUPPORTED_VERSION"));

    it("newer required reader", () => expectParseError((b) => dv(b).setUint16(12, 2, true), "MLOD_UNSUPPORTED_VERSION"));

    it("bad endian tag", () => expectParseError((b) => dv(b).setUint32(16, 0x04030201, true), "MLOD_UNSUPPORTED_ENDIAN"));

    it("bad header size", () => expectParseError((b) => dv(b).setUint32(20, 128, true), "MLOD_HEADER_INTEGRITY"));

    it("truncated below header", () => expectParseError(() => new Uint8Array(50), "MLOD_TRUNCATED"));

    it("truncated body", () => expectParseError((b, layout) => b.slice(0, layout.totalBytes - 4096), "MLOD_TRUNCATED"));

    it("header reserved not zero", () => expectParseError((b, layout) => void (b[layout.headerReserved] = 1), "MLOD_INVALID_LAYOUT"));

    it("header CRC mismatch", () => expectParseError((b) => dv(b).setFloat32(200, 42, true), "MLOD_HEADER_INTEGRITY"));

    it("directory CRC mismatch", () => expectParseError((b, layout) => void (b[layout.directoryOffset + 4] = b[layout.directoryOffset + 4]! ^ 0x01), "MLOD_DIRECTORY_INTEGRITY"));

    it("section CRC mismatch", () => expectParseError((b, layout) => void (b[layout.groupOffset] = b[layout.groupOffset]! ^ 0x01), "MLOD_SECTION_INTEGRITY"));

    it("page CRC mismatch", () => expectParseError((b, layout) => void (b[layout.pageDataOffset + 32] = b[layout.pageDataOffset + 32]! ^ 0x01), "MLOD_PAGE_INTEGRITY"));

    it("section entry reserved not zero", () =>
        expectParseError((b, layout) => {
            b[layout.firstEntry + 48] = 1;
            resealContainer(b);
        }, "MLOD_INVALID_LAYOUT"));

    it("misordered required section", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.firstEntry, 5, true);
            resealContainer(b);
        }, "MLOD_INVALID_LAYOUT"));

    it("page size violation", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.pageTableOffset + 8, 32768, true);
            resealContainer(b);
        }, "MLOD_INVALID_LAYOUT"));

    it.each([0, PAGE_MAX_BYTES + 1, 1024 * 1024 * 1024])("rejects CRC-correct decoded page allocation %i before decoding", (decodedBytes) =>
        expectParseError((bytes, layout) => {
            dv(bytes).setUint32(layout.pageTableOffset + 16, decodedBytes, true);
            resealContainer(bytes);
        }, "MLOD_INVALID_LAYOUT")
    );

    it("accepts the maximum decoded page allocation", () => {
        const { bytes, layout } = buildMinimalContainer();
        dv(bytes).setUint32(layout.pageTableOffset + 16, PAGE_MAX_BYTES, true);
        resealContainer(bytes);
        expect(parseMeshLoDContainer(bytes).pageRecords[0]!.decodedBytes).toBe(PAGE_MAX_BYTES);
    });

    it("rejects an oversized fine-page declaration from a CRC-correct coarse bootstrap without fetching or decoding that page", () => {
        const path = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
        const bytes = new Uint8Array(readFileSync(path));
        const parsed = parseMeshLoDContainer(bytes);
        const finePageId = parsed.pageRecords.findIndex((page) => !page.pinned);
        expect(finePageId).toBeGreaterThanOrEqual(0);
        const tableOffset = parsed.sections[SECTION_PAGE_TABLE - 1]!.offset;
        dv(bytes).setUint32(tableOffset + finePageId * PAGE_TABLE_RECORD_SIZE + 16, 1024 * 1024 * 1024, true);
        resealContainer(bytes);
        const bootstrap = bytes.subarray(0, parsed.header.bootstrapBytes);
        expect(bootstrap.length).toBeLessThan(parsed.pageRecords[finePageId]!.offset + parsed.pageRecords[finePageId]!.storedBytes);
        expect(() => parseMeshLoDContainer(bootstrap)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_LAYOUT", pageId: finePageId, actual: 1024 * 1024 * 1024 }));
    });

    it("cluster owning group out of range", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.clusterOffset + 20, 99, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("cluster refined group invalid", () =>
        expectParseError((b, layout) => {
            dv(b).setInt32(layout.clusterOffset + 24, 5, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("cluster page id out of range", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.clusterOffset + 28, 99, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("group cluster range out of bounds", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.groupOffset + 28, 99, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it.each([1, 0xffffffff])("group page ref offset %i exceeds the reference table", (firstRef) =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.groupOffset + 32, firstRef, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY")
    );

    it("group page ref count exceeds the reference table", () =>
        expectParseError((b, layout) => {
            dv(b).setUint16(layout.groupOffset + 36, 2, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("cluster local indices exceed their owning page", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.clusterOffset + 64 + 36, 4, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("cluster vertices exceed their owning page", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.clusterOffset + 64 + 32, 4, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));

    it("page cluster range out of bounds", () =>
        expectParseError((b, layout) => {
            dv(b).setUint32(layout.pageTableOffset + 44, 99, true);
            resealContainer(b);
        }, "MLOD_INVALID_HIERARCHY"));
});
