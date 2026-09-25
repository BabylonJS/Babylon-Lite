import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        bakeCurrentTransformIntoVertices: vi.fn((mesh: LiteGaussianSplattingMesh) => {
            mesh.position.set(0, 0, 0);
            mesh.rotationQuaternion.set(0, 0, 0, 1);
            mesh.scaling.set(1, 1, 1);
        }),
        loadSplat: vi.fn(),
        loadSOG: vi.fn(),
        loadSPZ: vi.fn(),
    };
});

import { createTransformNode, loadSOG, loadSPZ, loadSplat } from "babylon-lite";
import type { GaussianSplattingMesh as LiteGaussianSplattingMesh } from "babylon-lite";

import { LiteCompatError } from "../src/error";
import { SPLATFileLoader, RegisterSPLATFileLoader } from "../src/loading/splat-file-loader";
import { GaussianSplattingMesh } from "../src/meshes/gaussian-splatting";
import { TransformNode } from "../src/meshes/meshes";
import type { Scene } from "../src/scene/scene";

function fakeLiteMesh(rotationX = 0): LiteGaussianSplattingMesh {
    const node = createTransformNode("loaded");
    node.rotation.x = rotationX;
    (node as unknown as { _orderPool: unknown[] })._orderPool = [];
    return node as unknown as LiteGaussianSplattingMesh;
}

function fakeScene(): Scene {
    return {
        _lite: { marker: "scene" },
        _registerMesh: vi.fn(),
    } as unknown as Scene;
}

describe("SPLATFileLoader", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadSplat).mockResolvedValue(fakeLiteMesh());
        vi.mocked(loadSOG).mockResolvedValue(fakeLiteMesh());
        vi.mocked(loadSPZ).mockResolvedValue(fakeLiteMesh());
    });

    it("matches the Babylon.js plugin identity and registration shape", () => {
        const loader = new SPLATFileLoader();
        expect(loader.name).toBe("splat");
        expect(loader.extensions).toEqual({
            ".splat": { isBinary: true },
            ".ply": { isBinary: true },
            ".spz": { isBinary: true },
            ".json": { isBinary: false },
            ".sog": { isBinary: true },
        });
        expect(RegisterSPLATFileLoader()).toBeUndefined();
    });

    it.each([
        ["cloud.ply", new Uint8Array([0x70, 0x6c, 0x79]), loadSplat],
        ["cloud.splat", new Uint8Array(32), loadSplat],
        ["cloud.sog", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), loadSOG],
        ["cloud.spz", new Uint8Array([0x4e, 0x47, 0x53, 0x50]), loadSPZ],
    ] as const)("forwards %s binary data to the matching Lite loader", async (fileName, data, expectedLoader) => {
        const scene = fakeScene();
        const progress = vi.fn();
        const result = await new SPLATFileLoader().importMeshAsync(null, scene, data, "", progress, fileName);
        const blobUrl = vi.mocked(expectedLoader).mock.calls[0]![1];

        expect(expectedLoader).toHaveBeenCalledOnce();
        expect(expectedLoader).toHaveBeenCalledWith(scene._lite, expect.stringMatching(/^blob:/));
        expect(blobUrl).toMatch(/^blob:/);
        expect(result.meshes[0]?.name).toBe("GaussianSplatting");
        expect(result).toMatchObject({
            particleSystems: [],
            skeletons: [],
            animationGroups: [],
            transformNodes: [],
            geometries: [],
            lights: [],
            spriteManagers: [],
        });
        expect(progress).not.toHaveBeenCalled();
    });

    it("sniffs compressed formats when loadAsync has no filename", async () => {
        const scene = fakeScene();
        await new SPLATFileLoader().loadAsync(scene, new Uint8Array([0x1f, 0x8b, 0, 0]), "");
        await new SPLATFileLoader().loadAsync(scene, new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "");

        expect(loadSPZ).toHaveBeenCalledOnce();
        expect(loadSOG).toHaveBeenCalledOnce();
    });

    it("forwards the original binary bytes through the object URL", async () => {
        let forwarded: Blob | undefined;
        const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
            if (!(blob instanceof Blob)) {
                throw new TypeError("Expected a Blob");
            }
            forwarded = blob;
            return "blob:test";
        });
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

        try {
            await new SPLATFileLoader().importMeshAsync(null, fakeScene(), new Uint8Array([1, 2, 3, 4]), "");
            expect([...new Uint8Array(await forwarded!.arrayBuffer())]).toEqual([1, 2, 3, 4]);
            expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
        } finally {
            createObjectURL.mockRestore();
            revokeObjectURL.mockRestore();
        }
    });

    it("adopts loaded data into the configured Babylon.js mesh", async () => {
        const scene = fakeScene();
        const target = { _adopt: vi.fn(), name: "target" };
        const loaded = fakeLiteMesh();
        vi.mocked(loadSplat).mockResolvedValue(loaded);

        const result = await new SPLATFileLoader({
            gaussianSplattingMesh: target as never,
        }).importMeshAsync(null, scene, new Uint8Array(32), "", undefined, "cloud.splat");

        expect(target._adopt).toHaveBeenCalledWith(loaded);
        expect(result.meshes).toEqual([target]);
    });

    it.each([
        ["SOG", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), loadSOG],
        ["SPZ", new Uint8Array([0x4e, 0x47, 0x53, 0x50]), loadSPZ],
    ] as const)("composes an existing target transform with the native %s orientation", async (_format, data, expectedLoader) => {
        const scene = fakeScene();
        const target = new GaussianSplattingMesh("target", null, scene);
        target.rotation.x = 0.25;
        const loaded = fakeLiteMesh(Math.PI);
        vi.mocked(expectedLoader).mockResolvedValue(loaded);

        const result = await new SPLATFileLoader({ gaussianSplattingMesh: target }).importMeshAsync(null, scene, data, "");

        expect(result.meshes).toEqual([target]);
        expect(loaded.rotation.x).toBeCloseTo(Math.PI);
        expect(loaded.parent).toBe(target._node);
        expect(target.rotation.x).toBeCloseTo(0.25);
    });

    it("preserves ordinary child world transforms when baking an adopted target", () => {
        const target = new GaussianSplattingMesh("target", null, fakeScene());
        target.position.x = 5;
        const loaded = fakeLiteMesh();
        target._adopt(loaded);
        const child = new TransformNode("child");
        child.position.x = 2;
        child.parent = target;

        expect(child._node.worldMatrix[12]).toBeCloseTo(7);

        target.bakeCurrentTransformIntoVertices();

        expect(target.position.x).toBe(0);
        expect(loaded.parent).toBe(target._node);
        expect(child.parent).toBe(target);
        expect(child._node.parent).toBe(target._node);
        expect(child._node.worldMatrix[12]).toBeCloseTo(7);
    });

    it("ignores stale Lite children after a public reparent between bakes", () => {
        const target = new GaussianSplattingMesh("target", null, fakeScene());
        target.position.x = 5;
        target._adopt(fakeLiteMesh());
        const child = new TransformNode("child");
        child.position.x = 2;
        child.parent = target;

        target.bakeCurrentTransformIntoVertices();

        const otherParent = new TransformNode("otherParent");
        otherParent.position.x = 10;
        child.parent = otherParent;
        const reparentedWorldX = child._node.worldMatrix[12]!;

        target.bakeCurrentTransformIntoVertices();

        expect(child.parent).toBe(otherParent);
        expect(child._node.parent).toBe(otherParent._node);
        expect(child._node.worldMatrix[12]).toBeCloseTo(reparentedWorldX);
    });

    it("rejects an already-loaded target before creating another Lite mesh", async () => {
        const target = { _pickLiteNode: fakeLiteMesh(), _adopt: vi.fn(), name: "target" };
        const loader = new SPLATFileLoader({ gaussianSplattingMesh: target as never });

        await expect(loader.importMeshAsync(null, fakeScene(), new Uint8Array(32), "", undefined, "cloud.splat")).rejects.toThrow(/replacement lifecycle/);
        expect(loadSplat).not.toHaveBeenCalled();
        expect(target._adopt).not.toHaveBeenCalled();
    });

    it("reserves an unloaded target across concurrent plugin instances", async () => {
        let resolveLoad: ((mesh: LiteGaussianSplattingMesh) => void) | undefined;
        vi.mocked(loadSplat).mockReturnValue(
            new Promise((resolve) => {
                resolveLoad = resolve;
            })
        );
        const target = { _adopt: vi.fn(), name: "target" };
        const first = new SPLATFileLoader({ gaussianSplattingMesh: target as never });
        const second = new SPLATFileLoader({ gaussianSplattingMesh: target as never });

        const firstLoad = first.importMeshAsync(null, fakeScene(), new Uint8Array(32), "", undefined, "first.splat");
        await expect(second.importMeshAsync(null, fakeScene(), new Uint8Array(32), "", undefined, "second.splat")).rejects.toThrow(/one in-flight load/);
        expect(loadSplat).toHaveBeenCalledOnce();

        const loaded = fakeLiteMesh();
        resolveLoad!(loaded);
        await expect(firstLoad).resolves.toMatchObject({ meshes: [target] });
        expect(target._adopt).toHaveBeenCalledOnce();
        expect(target._adopt).toHaveBeenCalledWith(loaded);
    });

    it("releases an unloaded target reservation when loading fails", async () => {
        const target = { _adopt: vi.fn(), name: "target" };
        vi.mocked(loadSplat).mockRejectedValueOnce(new Error("load failed")).mockResolvedValueOnce(fakeLiteMesh());

        await expect(
            new SPLATFileLoader({ gaussianSplattingMesh: target as never }).importMeshAsync(null, fakeScene(), new Uint8Array(32), "", undefined, "first.splat")
        ).rejects.toThrow("load failed");
        await expect(
            new SPLATFileLoader({ gaussianSplattingMesh: target as never }).importMeshAsync(null, fakeScene(), new Uint8Array(32), "", undefined, "retry.splat")
        ).resolves.toMatchObject({ meshes: [target] });
        expect(loadSplat).toHaveBeenCalledTimes(2);
        expect(target._adopt).toHaveBeenCalledOnce();
    });

    it("accepts the BJS flipY default and rejects the unsupported override", () => {
        expect(() => new SPLATFileLoader({ flipY: false })).not.toThrow();
        expect(() => new SPLATFileLoader({ flipY: true })).toThrow(/flipY/);
    });

    it("uses only SceneLoader plugin options when creating a plugin", () => {
        const loader = new SPLATFileLoader({ keepInRam: true });
        const plugin = loader.createPlugin({ splat: { disableAutoCameraLimits: true } });
        const pluginOptions = (plugin as unknown as { _loadingOptions: Record<string, unknown> })._loadingOptions;

        expect(pluginOptions).toEqual({ disableAutoCameraLimits: true });
        expect(() => loader.createPlugin({ splat: { useSogTextures: true } })).toThrow(LiteCompatError);
        expect(() => loader.createPlugin({ splat: { useSogTextures: true } })).toThrow(/useSogTextures/);
    });

    it("fails explicitly for structurally blocked JSON and container paths", async () => {
        const loader = new SPLATFileLoader();
        await expect(loader.importMeshAsync(null, fakeScene(), '{"lods":[]}', "", undefined, "lod-meta.json")).rejects.toThrow(/streaming residency/);
        await expect(loader.importMeshAsync(null, fakeScene(), '{"means":{}}', "", undefined, "meta.json")).rejects.toThrow(/external texture resources/);
        expect(() => loader.loadAssetContainerAsync(fakeScene(), "", "")).toThrow(/asset-container lifecycle/);
    });
});
