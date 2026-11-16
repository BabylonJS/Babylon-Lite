import { describe, expect, it, vi } from "vitest";
import { loadSplatVoxelCollision, moveSplatVoxelCamera, parseSplatVoxelCollision } from "../../../packages/babylon-lite/src/collision/splat-voxel-collision";
import { resolveTrogirAssets } from "../../../lab/lite/src/demos/trogir-assets";
import { attachTrogirCollision } from "../../../lab/lite/src/demos/trogir-collision";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function metadata(nodeCount = 2, leafDataCount = 2) {
    return { version: "1.1", leafSize: 4, treeDepth: 1, voxelResolution: 1, gridBounds: { min: [0, 0, 0], max: [8, 8, 8] }, nodeCount, leafDataCount };
}

function collision() {
    // A single occupied voxel at (2, 1, 1), stored in root octant zero.
    return parseSplatVoxelCollision(metadata(), new Uint32Array([0x01000001, 0, 1 << 22, 0]).buffer);
}

describe("splat voxel navigation", () => {
    it("sweeps long moves through thin walls in both directions and slides along their surface", () => {
        const grid = collision();
        const forward = moveSplatVoxelCamera(grid, [0.5, 1.5, 1.5], [7, 1.5, 1.5]);
        expect(forward[0]).toBeCloseTo(1.85, 3);
        const reverse = moveSplatVoxelCamera(grid, [7, 1.5, 1.5], [0.5, 1.5, 1.5]);
        expect(reverse[0]).toBeCloseTo(3.15, 3);
        const slide = moveSplatVoxelCamera(grid, [0.5, 1.5, 1.5], [7, 2, 1.5]);
        expect(slide[0]).toBeCloseTo(1.85, 3);
        expect(slide[1]).toBeCloseTo(2, 3);
        expect(moveSplatVoxelCamera(grid, forward, [0.5, 1.5, 1.5])).toEqual([0.5, 1.5, 1.5]);
    });

    it("preserves empty paths, blocks the domain boundary and handles a solid collapsed octant", () => {
        const empty = parseSplatVoxelCollision(metadata(0, 0), new ArrayBuffer(0));
        expect(moveSplatVoxelCamera(empty, [1, 1, 1], [2, 3, 4])).toEqual([2, 3, 4]);
        expect(moveSplatVoxelCamera(empty, [1, 1, 1], [100, 1, 1])[0]).toBeCloseTo(7.85, 3);
        const solid = parseSplatVoxelCollision(metadata(2, 0), new Uint32Array([0x02000001, 0xff000000]).buffer);
        expect(moveSplatVoxelCamera(solid, [1, 1, 1], [7, 1, 1])[0]).toBeCloseTo(3.85, 3);
        expect(() => moveSplatVoxelCamera(empty, [NaN, 1, 1], [2, 3, 4])).toThrow(RangeError);
    });

    it("reads the upper half of mixed-leaf masks and nonzero octant indices", () => {
        const grid = parseSplatVoxelCollision(metadata(), new Uint32Array([0x80000001, 0, 0, 1 << 6]).buffer);
        // Octant 7, local cell (2,1,2) -> world cell (6,5,6).
        expect(moveSplatVoxelCamera(grid, [4.5, 5.5, 6.5], [7.5, 5.5, 6.5])[0]).toBeCloseTo(5.85, 3);
    });

    it("rejects unsupported headers, truncated data, invalid indices, depths and shared children", () => {
        const data = new Uint32Array([0x01000001, 0, 1 << 22, 0]).buffer;
        expect(() => parseSplatVoxelCollision({ ...metadata(), version: "1.0" }, data)).toThrow();
        expect(() => parseSplatVoxelCollision({ ...metadata(), voxelResolution: 0 }, data)).toThrow();
        expect(() => parseSplatVoxelCollision(metadata(), data.slice(4))).toThrow();
        expect(() => parseSplatVoxelCollision(metadata(), new Uint32Array([0x01000002, 0, 1, 0]).buffer)).toThrow();
        expect(() => parseSplatVoxelCollision(metadata(), new Uint32Array([0x01000001, 1, 1, 0]).buffer)).toThrow();
        expect(() => parseSplatVoxelCollision(metadata(), new Uint32Array([0, 0, 1, 0]).buffer)).toThrow();
        expect(() => parseSplatVoxelCollision({ ...metadata(4, 0), treeDepth: 2 }, new Uint32Array([0x03000001, 0x01000003, 0x01000003, 0xff000000]).buffer)).toThrow();
    });

    it("converts Lite Z once, corrects the target with the eye, and detaches idempotently", () => {
        const camera = createFreeCamera({ x: 0.5, y: 1.5, z: -1.5 }, { x: 1.5, y: 1.5, z: -1.5 });
        const scene = { _beforeRender: [] } as unknown as SceneContext;
        const detach = attachTrogirCollision(camera, scene, collision());
        camera.position.x = 7;
        camera.target.x = 8;
        scene._beforeRender[0]!(16);
        expect(camera.position.x).toBeCloseTo(1.85, 3);
        expect(camera.target.x - camera.position.x).toBeCloseTo(1, 6);
        expect(camera.position.z).toBe(-1.5);
        detach();
        detach();
        expect(scene._beforeRender).toHaveLength(0);
    });

    it("resolves public, alternate-root and explicit collision assets without mixing datasets", () => {
        const publicAssets = resolveTrogirAssets("https://example.test/demo.html");
        expect(publicAssets.metadataUrl).toContain("assets.babylonjs.com/splats/Trogir/");
        expect(publicAssets.collisionUrl).toBe("https://assets.babylonjs.com/splats/Trogir/scene.voxel.json");
        const custom = resolveTrogirAssets("https://example.test/demo.html?assetRoot=/local-gs/other/");
        expect(custom).toEqual({ metadataUrl: "https://example.test/local-gs/other/lod-meta.json", collisionUrl: "https://example.test/local-gs/other/scene.voxel.json" });
        expect(resolveTrogirAssets("https://example.test/demo.html?assetRoot=/data/lod-meta.json&collisionUrl=/nav/custom.voxel.json").collisionUrl).toBe(
            "https://example.test/nav/custom.voxel.json"
        );
        expect(() => resolveTrogirAssets("https://example.test/demo.html?collisionUrl=file:///scene.voxel.json")).toThrow();
        expect(() => resolveTrogirAssets("https://example.test/demo.html?assetRoot=file:///data/")).toThrow();
    });

    it.each(["https://cdn.test/data/", "https://cdn.test/data/lod-meta.json"])("preserves root queries on the manifest and voxel pair from %s", (root) => {
        const query = "?sig=a%2Fb%2Bc&v=7";
        const page = new URL("https://example.test/demo.html");
        page.searchParams.set("assetRoot", root + query);
        const expected = {
            metadataUrl: "https://cdn.test/data/lod-meta.json" + query,
            collisionUrl: "https://cdn.test/data/scene.voxel.json" + query,
        };
        expect(resolveTrogirAssets(page.href)).toEqual(expected);
        page.searchParams.set("collisionUrl", "");
        expect(resolveTrogirAssets(page.href)).toEqual(expected);
    });

    it.each(["https://assets.babylonjs.com/splats/Trogir/", "https://assets.babylonjs.com/splats/Trogir/lod-meta.json"])(
        "preserves queries on the sibling collision pair for the explicit default root %s",
        (root) => {
            const page = new URL("https://example.test/demo.html");
            page.searchParams.set("assetRoot", root + "?v=7");
            expect(resolveTrogirAssets(page.href)).toEqual({
                metadataUrl: "https://assets.babylonjs.com/splats/Trogir/lod-meta.json?v=7",
                collisionUrl: "https://assets.babylonjs.com/splats/Trogir/scene.voxel.json?v=7",
            });
            page.searchParams.set("collisionUrl", "/nav/custom.voxel.json?sig=other");
            expect(resolveTrogirAssets(page.href).collisionUrl).toBe("https://example.test/nav/custom.voxel.json?sig=other");
        }
    );

    it.each([
        ["/nav/custom.voxel.json", "https://example.test/nav/custom.voxel.json"],
        ["/nav/custom.voxel.json?v=2", "https://example.test/nav/custom.voxel.json?v=2"],
        ["https://nav.test/custom.voxel.json?sig=other", "https://nav.test/custom.voxel.json?sig=other"],
    ])("keeps an explicit collision URL's query independent: %s", (override, expected) => {
        const page = new URL("https://example.test/demo.html");
        page.searchParams.set("assetRoot", "https://cdn.test/data/?sig=abc&v=7");
        page.searchParams.set("collisionUrl", override!);
        expect(resolveTrogirAssets(page.href)).toEqual({
            metadataUrl: "https://cdn.test/data/lod-meta.json?sig=abc&v=7",
            collisionUrl: expected,
        });
    });

    it("loads bounded sibling assets with cancellation and rejects incomplete binary data", async () => {
        const signal = new AbortController().signal;
        const urls: string[] = [];
        const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
            urls.push(url.href);
            expect(init?.signal).toBe(signal);
            return url.pathname.endsWith(".json") ? new Response(JSON.stringify(metadata())) : new Response(new Uint32Array([0x01000001, 0, 1 << 22, 0]));
        });
        vi.stubGlobal("fetch", fetchMock);
        try {
            const grid = await loadSplatVoxelCollision("https://a.test/scene.voxel.json?v=1", signal);
            expect(grid.nodes).toHaveLength(2);
            expect(urls).toEqual(["https://a.test/scene.voxel.json?v=1", "https://a.test/scene.voxel.bin?v=1"]);
            fetchMock.mockImplementation(async (url) => (url.pathname.endsWith(".json") ? new Response(JSON.stringify(metadata())) : new Response(new Uint8Array(4))));
            await expect(loadSplatVoxelCollision("https://a.test/scene.voxel.json")).rejects.toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
