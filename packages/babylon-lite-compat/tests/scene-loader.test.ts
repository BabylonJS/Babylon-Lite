import { describe, expect, it, vi } from "vitest";

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, addToScene: vi.fn(), removeFromScene: vi.fn(), setParent: vi.fn((mesh: { parent: unknown }, parent: unknown) => (mesh.parent = parent)) };
});

import { addToScene, removeFromScene, setParent } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer, Mesh as LiteMesh } from "babylon-lite";

import { AssetContainer } from "../src/loading/scene-loader";
import { Observable } from "../src/misc/observable";
import { AbstractScene } from "../src/scene/abstract-scene";
import type { Scene } from "../src/scene/scene";

interface FakeMesh {
    name: string;
    children: FakeMesh[];
    parent: FakeMesh | null;
    _gpu: object;
    material: object;
}

class TestScene extends AbstractScene {
    public readonly _lite = {};
    public readonly onDisposeObservable = new Observable<Scene>();

    public _surfaceLoadedCamera(): void {}
}

describe("AssetContainer.addAllToScene", () => {
    it("registers the canonical loaded wrappers in scene.meshes", () => {
        const mesh = { name: "Cube", children: [], _gpu: {} };
        const root = { name: "__root__", children: [mesh] };
        const lite = { entities: [root] } as unknown as LiteAssetContainer;
        const container = new AssetContainer(lite);
        const register = vi.fn();
        const scene = {
            _lite: {},
            _registerMesh: register,
            _surfaceLoadedCamera: vi.fn(),
        } as unknown as Scene;

        const wrappers = container.meshes;
        container.addAllToScene(scene);

        expect(addToScene).toHaveBeenCalledWith(scene._lite, lite);
        expect(register.mock.calls).toEqual([
            [wrappers[0], root],
            [wrappers[1], mesh],
        ]);
        expect(container.meshes).toEqual(wrappers);
    });

    it("detaches reparented USD meshes and retires their canonical wrappers", () => {
        const mesh: FakeMesh = { name: "Cube", children: [], parent: null, _gpu: {}, material: {} };
        const root = { name: "__root__", children: [mesh] };
        const lite = { entities: [root] } as unknown as LiteAssetContainer;
        const disposeUsd = vi.fn();
        const container = new AssetContainer(lite, disposeUsd, [mesh as unknown as LiteMesh]);
        const removeFromSceneMock = vi.mocked(removeFromScene);
        const testScene = new TestScene();
        const scene = testScene as unknown as Scene;

        container.addAllToScene(scene);
        const wrappers = container.meshes;
        const disposed = wrappers.map(() => vi.fn(() => undefined));
        wrappers.forEach((wrapper, index) => wrapper.onDisposeObservable.add(disposed[index]!));
        expect(testScene.meshes).toEqual(wrappers);
        expect(testScene.getMeshByName("Cube")).toBe(wrappers[1]);
        expect(testScene.getMeshById("Cube")).toBe(wrappers[1]);

        root.children.length = 0;
        mesh.parent = null;
        container.dispose();

        expect(setParent).toHaveBeenCalledWith(mesh, null);
        expect(removeFromScene).toHaveBeenCalledWith(scene._lite, mesh);
        expect(removeFromSceneMock.mock.invocationCallOrder.at(-1)).toBeLessThan(disposeUsd.mock.invocationCallOrder[0]!);
        expect(testScene.meshes).toEqual([]);
        expect(testScene.getMeshByName("Cube")).toBeNull();
        expect(testScene.getMeshById("Cube")).toBeNull();
        expect(wrappers.every((wrapper) => wrapper.isDisposed())).toBe(true);
        expect(disposed.every((observer) => observer.mock.calls.length === 1)).toBe(true);
    });

    it("retires canonical wrappers when an asset container was never added to a scene", () => {
        const mesh: FakeMesh = { name: "Cube", children: [], parent: null, _gpu: {}, material: {} };
        const root = { name: "__root__", children: [mesh] };
        const lite = { entities: [root] } as unknown as LiteAssetContainer;
        const disposeUsd = vi.fn();
        const container = new AssetContainer(lite, disposeUsd, [mesh as unknown as LiteMesh]);
        const wrappers = container.meshes;
        const disposed = wrappers.map(() => vi.fn(() => undefined));
        wrappers.forEach((wrapper, index) => wrapper.onDisposeObservable.add(disposed[index]!));

        container.dispose();

        expect(disposeUsd).toHaveBeenCalledOnce();
        expect(wrappers.every((wrapper) => wrapper.isDisposed())).toBe(true);
        expect(disposed.every((observer) => observer.mock.calls.length === 1)).toBe(true);
        expect(container.meshes).toEqual(wrappers);
    });

    it("does not create wrappers after disposing an unread asset container", () => {
        const mesh: FakeMesh = { name: "Cube", children: [], parent: null, _gpu: {}, material: {} };
        const root = { name: "__root__", children: [mesh] };
        const lite = { entities: [root] } as unknown as LiteAssetContainer;
        const container = new AssetContainer(lite, vi.fn(), [mesh as unknown as LiteMesh]);

        container.dispose();

        expect(container.meshes).toEqual([]);
    });
});
