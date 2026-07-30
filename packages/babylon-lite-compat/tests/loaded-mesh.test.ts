import { describe, expect, it, vi } from "vitest";

/**
 * GPU-free coverage for the canonical loaded-mesh wrappers (`collectLoadedMeshes`
 * + `Mesh._fromLite` + `Mesh.clone`). Constructing a `Mesh` over an already-loaded
 * Lite node touches no GPU, so we drive the real hierarchy reconstruction against
 * a fake Lite container and only mock the two Lite calls that would need a device:
 * `cloneTransformNode` (clone) and `addToScene` (scene insertion).
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        addToScene: vi.fn(),
        cloneTransformNode: vi.fn(function clone(src: FakeLite): FakeLite {
            const result: FakeLite = { ...src, name: src.name + "_clone", children: [], visible: src.visible };
            result.children = src.children.map((child) => clone(child));
            return result;
        }),
    };
});

import { addToScene, cloneTransformNode } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer } from "babylon-lite";

import { collectLoadedMeshes, type LoadedMeshRegistry } from "../src/loading/loaded-mesh";
import { Mesh } from "../src/meshes/meshes";
import type { Scene } from "../src/scene/scene";

const addToSceneMock = vi.mocked(addToScene);
const cloneTransformNodeMock = vi.mocked(cloneTransformNode);

interface FakeLite {
    name: string;
    children: FakeLite[];
    visible?: boolean;
    _gpu?: object;
}

/** A renderable Lite mesh node (carries `_gpu`). */
function liteMesh(name: string): FakeLite {
    return { name, children: [], visible: true, _gpu: {} };
}

/** The loader's synthetic `__root__` transform node (no `_gpu`, parents the meshes). */
function liteRoot(children: FakeLite[]): FakeLite {
    return { name: "__root__", children, visible: true };
}

/** A minimal compat `Scene` stand-in exposing only what the wrappers touch. */
function fakeScene(): { scene: Scene; registered: unknown[] } {
    const registered: unknown[] = [];
    const scene = {
        _lite: {},
        _deferAdd: (add: () => void) => add(),
        _registerMesh: (mesh: unknown) => registered.push(mesh),
        _unregisterNode: (mesh: unknown) => {
            const index = registered.indexOf(mesh);
            if (index !== -1) {
                registered.splice(index, 1);
            }
        },
    } as unknown as Scene;
    return { scene, registered };
}

function fakeContainer(...entities: FakeLite[]): LiteAssetContainer {
    return { entities } as unknown as LiteAssetContainer;
}

describe("collectLoadedMeshes", () => {
    it("wraps every loaded node as a real compat Mesh with __root__ at index 0", () => {
        const cube = liteMesh("Cube");
        const container = fakeContainer(liteRoot([cube]));
        const registry: LoadedMeshRegistry = new Map();

        const meshes = collectLoadedMeshes(container, registry);
        expect(meshes).toHaveLength(2);
        expect(meshes[0]).toBeInstanceOf(Mesh);
        expect(meshes[0]!.getClassName()).toBe("Mesh");
        expect(meshes[0]!.name).toBe("__root__");
        expect(meshes[1]!.name).toBe("Cube");
    });

    it("returns stable wrapper identity across repeated reads", () => {
        const container = fakeContainer(liteRoot([liteMesh("Cube")]));
        const registry: LoadedMeshRegistry = new Map();

        const first = collectLoadedMeshes(container, registry);
        const second = collectLoadedMeshes(container, registry);
        expect(second[0]).toBe(first[0]);
        expect(second[1]).toBe(first[1]);
    });

    it("constructs each hierarchy node only once per collection", () => {
        const container = fakeContainer(liteRoot([liteMesh("Parent"), liteMesh("Child")]));
        const fromHierarchy = vi.spyOn(Mesh, "_fromLiteHierarchy");

        collectLoadedMeshes(container, new Map());

        expect(fromHierarchy).toHaveBeenCalledTimes(3);
        fromHierarchy.mockRestore();
    });

    it("carries the source Lite container on each wrapper for KHR_materials_variants", () => {
        const container = fakeContainer(liteRoot([liteMesh("Cube")]));
        const registry: LoadedMeshRegistry = new Map();

        const meshes = collectLoadedMeshes(container, registry);
        expect((meshes[0] as unknown as { _container: unknown })._container).toBe(container);
    });

    it("binds wrappers to the scene (registered in scene.meshes) without re-inserting into Lite", () => {
        const container = fakeContainer(liteRoot([liteMesh("Cube")]));
        const registry: LoadedMeshRegistry = new Map();
        const { scene, registered } = fakeScene();

        const meshes = collectLoadedMeshes(container, registry, scene);
        expect(registered).toEqual(meshes);
        // Binding never re-adds the already-loaded nodes to the Lite scene.
        expect(addToSceneMock).not.toHaveBeenCalled();

        // Re-binding the same scene is a no-op (no duplicate registration).
        collectLoadedMeshes(container, registry, scene);
        expect(registered).toHaveLength(2);
    });

    it("exposes transform + visibility proxies on loaded meshes", () => {
        const cube = liteMesh("Cube");
        const container = fakeContainer(liteRoot([cube]));
        const meshes = collectLoadedMeshes(container, new Map());
        const mesh = meshes[1]!;

        mesh.setEnabled(false);
        expect(cube.visible).toBe(false);
        mesh.setEnabled(true);
        expect(cube.visible).toBe(true);
    });

    it("reconstructs the loaded hierarchy and unregisters descendants on disposal", () => {
        const child = liteMesh("Child");
        const root = liteRoot([child]);
        const { scene, registered } = fakeScene();
        const meshes = collectLoadedMeshes(fakeContainer(root), new Map(), scene);

        expect(meshes[1]!.parent).toBe(meshes[0]);
        expect(meshes[0]!.getChildMeshes()).toEqual([meshes[1]]);
        meshes[0]!.dispose();
        expect(registered).toEqual([]);
    });

    it("preserves loaded visibility across enabled-state changes", () => {
        const cube = liteMesh("Cube");
        cube.visible = false;
        const mesh = collectLoadedMeshes(fakeContainer(liteRoot([cube])), new Map())[1]!;

        expect(mesh.isVisible).toBe(false);
        mesh.setEnabled(false);
        mesh.setEnabled(true);
        expect(cube.visible).toBe(false);
    });

    it("does not reveal hidden descendants when the loader root has implicit visibility", () => {
        const cube = liteMesh("Cube");
        cube.visible = false;
        const root = liteRoot([cube]);
        root.visible = undefined;

        const meshes = collectLoadedMeshes(fakeContainer(root), new Map());

        expect(cube.visible).toBe(false);
        expect(meshes[1]!.isVisible).toBe(false);
    });
});

describe("Mesh.clone", () => {
    it("deep-clones through Lite and adds the copy to the scene", () => {
        cloneTransformNodeMock.mockClear();
        addToSceneMock.mockClear();
        const container = fakeContainer(liteRoot([liteMesh("Cube")]));
        const { scene } = fakeScene();
        const source = collectLoadedMeshes(container, new Map(), scene)[1]!;

        const clone = (source as Mesh).clone("CubeCopy");
        expect(clone).toBeInstanceOf(Mesh);
        expect(clone.name).toBe("CubeCopy");
        expect(cloneTransformNodeMock).toHaveBeenCalledWith((source as unknown as { _lite: unknown })._lite);
        const cloneLite = cloneTransformNodeMock.mock.results[0]!.value;
        expect(addToSceneMock).toHaveBeenCalledWith((scene as unknown as { _lite: unknown })._lite, cloneLite);
    });

    it("wraps and registers cloned descendants", () => {
        const child = liteMesh("Child");
        const { scene, registered } = fakeScene();
        const source = collectLoadedMeshes(fakeContainer(liteRoot([liteMesh("Parent"), child])), new Map(), scene)[1] as Mesh;
        source._lite.children.push(child as never);

        const clone = source.clone("ParentCopy");

        expect(clone.getChildMeshes()).toHaveLength(1);
        expect(registered).toContain(clone);
        expect(registered).toContain(clone.getChildMeshes()[0]);
    });
});
