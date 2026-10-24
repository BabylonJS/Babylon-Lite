import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNavcatManager, disposeNavcatManager, exportNavcatMesh, replaceNavcatMesh } from "../../../packages/babylon-lite/src/navigation/navcat.js";
import { findNavcatNearestPoly } from "../../../packages/babylon-lite/src/navigation/navcat-queries.js";
import { addNavcatConnection, removeNavcatConnection } from "../../../packages/babylon-lite/src/navigation/navcat-connections.js";
import { createNavcatDebugGeometry } from "../../../packages/babylon-lite/src/navigation/navcat-debug.js";
import type { NavMesh } from "../../../packages/babylon-lite/node_modules/navcat";

const json = readFileSync(new URL("../../../lab/public/navcat/demo-navmesh.json", import.meta.url), "utf8");
const start = { x: -4, y: 0, z: 2 };
function asset(): { format: string; formatVersion: number; sdkVersion: string; navMesh: NavMesh } {
    return JSON.parse(json) as ReturnType<typeof asset>;
}

describe("Navcat versioned asset boundary", () => {
    it.each([
        ["format", "other", "unsupported format"],
        ["formatVersion", 2, "format version"],
        ["sdkVersion", "0.5.0", "SDK version"],
    ])("rejects incompatible %s before replacing a live mesh", async (key, value, message) => {
        const manager = await createNavcatManager(json);
        const input = { ...asset(), [key]: value };
        expect(() => replaceNavcatMesh(manager, JSON.stringify(input))).toThrow(String(message));
        expect(findNavcatNearestPoly(manager, start).success).toBe(true);
        expect(exportNavcatMesh(manager)).toBe(JSON.stringify(asset()));
        disposeNavcatManager(manager);
    });

    it("rejects unversioned SDK JSON explicitly", async () => {
        await expect(createNavcatManager(JSON.stringify(asset().navMesh))).rejects.toThrow("expected babylon-lite-navcat envelope");
    });

    it.each([
        [
            "polygon vertices",
            (m: NavMesh) => {
                m.tiles[0]!.polys[0]!.vertices[0] = 999999;
            },
        ],
        [
            "polygon neighbors",
            (m: NavMesh) => {
                m.tiles[0]!.polys[0]!.neis.pop();
            },
        ],
        [
            "polygon flags",
            (m: NavMesh) => {
                m.tiles[0]!.polys[0]!.flags = 65536;
            },
        ],
        [
            "detail range",
            (m: NavMesh) => {
                m.tiles[0]!.detailMeshes[0]!.trianglesCount = 999999;
            },
        ],
        [
            "detail triangle",
            (m: NavMesh) => {
                m.tiles[0]!.detailTriangles[0] = 999999;
            },
        ],
        [
            "BV bounds",
            (m: NavMesh) => {
                m.tiles[0]!.bvTree.nodes[0]!.bounds[3] = -999;
            },
        ],
        [
            "BV escape",
            (m: NavMesh) => {
                m.tiles[0]!.bvTree.nodes[0]!.i = -999999;
            },
        ],
        [
            "node identity",
            (m: NavMesh) => {
                m.nodes[0]!.index = 7;
            },
        ],
        [
            "node polygon",
            (m: NavMesh) => {
                m.nodes[0]!.polyIndex = 999999;
            },
        ],
        [
            "node flags",
            (m: NavMesh) => {
                m.nodes[0]!.flags = 65536;
            },
        ],
        [
            "node link",
            (m: NavMesh) => {
                m.nodes[0]!.links.push(999999);
            },
        ],
        [
            "link reference",
            (m: NavMesh) => {
                m.links[0]!.toNodeRef = 999999;
            },
        ],
        [
            "packed node reference",
            (m: NavMesh) => {
                m.nodes[0]!.ref = 999999;
                for (const link of m.links) {
                    if (link.fromNodeIndex === 0) {
                        link.fromNodeRef = 999999;
                    }
                    if (link.toNodeIndex === 0) {
                        link.toNodeRef = 999999;
                    }
                }
            },
        ],
        [
            "link edge",
            (m: NavMesh) => {
                m.links[0]!.edge = 999999;
            },
        ],
        [
            "pool counter",
            (m: NavMesh) => {
                m.nodeIndexPool.counter = 0;
            },
        ],
        [
            "allocated free node",
            (m: NavMesh) => {
                m.nodeIndexPool.free.push(0);
            },
        ],
        [
            "pool free list",
            (m: NavMesh) => {
                m.nodeIndexPool.free.push(-1);
            },
        ],
        [
            "tile mapping",
            (m: NavMesh) => {
                m.tilePositionToTileId["0,0,0"] = 999999;
            },
        ],
    ] satisfies [string, (mesh: NavMesh) => void][])("rejects corrupt %s without publishing it", async (_name, corrupt) => {
        const input = asset();
        corrupt(input.navMesh);
        const manager = await createNavcatManager(json);
        expect(() => replaceNavcatMesh(manager, JSON.stringify(input))).toThrow("Invalid Navcat JSON");
        expect(findNavcatNearestPoly(manager, start).success).toBe(true);
        disposeNavcatManager(manager);
    });

    it("roundtrips added and removed SDK connection pool entries", async () => {
        const manager = await createNavcatManager(json);
        const link = await addNavcatConnection(manager, { start: { x: -1.7, y: 0.1, z: 0 }, end: { x: 1.7, y: 0.1, z: 0 }, radius: 0.6 });
        const withLink = await createNavcatManager(exportNavcatMesh(manager));
        expect(findNavcatNearestPoly(withLink, start).success).toBe(true);
        disposeNavcatManager(withLink);
        await removeNavcatConnection(manager, link);
        const withoutLink = await createNavcatManager(exportNavcatMesh(manager));
        expect(findNavcatNearestPoly(withoutLink, start).success).toBe(true);
        disposeNavcatManager(withoutLink);
        disposeNavcatManager(manager);
    });

    it("returns owned Float32 debug positions", async () => {
        const manager = await createNavcatManager(json);
        const first = await createNavcatDebugGeometry(manager);
        expect(first.every((primitive) => primitive.positions instanceof Float32Array)).toBe(true);
        const saved = first[0]!.positions.slice();
        first[0]!.positions.fill(999);
        expect((await createNavcatDebugGeometry(manager))[0]!.positions).toEqual(saved);
        disposeNavcatManager(manager);
    });
});
