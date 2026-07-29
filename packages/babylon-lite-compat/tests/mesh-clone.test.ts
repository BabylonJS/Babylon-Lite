import { describe, expect, it, vi } from "vitest";

/**
 * `Mesh.clone(name, newParent?, doNotCloneChildren?)` (issue #473) forwards to
 * Lite's `cloneTransformNode` — which shares the ref-counted geometry with the
 * clone — then renames the clone (Lite hardcodes a `_clone` suffix), keeps the
 * source material, and registers it with the same compat scene through its own
 * wrapper. The real clone needs a GPU device, so these tests mock the Lite scene
 * functions and assert the pure forwarding/translation contract.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        cloneTransformNode: vi.fn((src: { name: string; material?: unknown }, children: unknown[] = []) => ({
            name: src.name + "_clone",
            material: src.material,
            children,
        })),
        addToScene: vi.fn(),
        removeFromScene: vi.fn(),
    };
});

import { cloneTransformNode, addToScene, removeFromScene } from "babylon-lite";
import { Mesh, TransformNode } from "../src/meshes/meshes";

const cloneTransformNodeMock = vi.mocked(cloneTransformNode);
const addToSceneMock = vi.mocked(addToScene);
const removeFromSceneMock = vi.mocked(removeFromScene);

/** Minimal compat `Scene` stand-in exposing only what `Mesh.clone` touches. */
function fakeScene(): { _lite: object; getEngine(): { _lite: object }; defaultMaterial: null; _deferAdd(add: () => void): void } {
    const engine = { _lite: {} };
    return {
        _lite: { tag: "scene-lite" },
        getEngine: () => engine,
        defaultMaterial: null,
        // The mesh under test is created after engine start, so run adds inline.
        _deferAdd: (add: () => void) => add(),
    };
}

/** A fake compat material carrying the Lite handle + renderable hook the add path calls. */
function fakeMaterial(): { _lite: object; _ensureRenderable: () => void } {
    return { _lite: { tag: "mat-lite" }, _ensureRenderable: vi.fn() };
}

/** Build a source `Mesh` wrapper without the GPU-backed constructor path. */
function sourceMesh(scene: ReturnType<typeof fakeScene>, material: unknown, liteChildren: unknown[] = []): Mesh {
    const mesh = Object.create(Mesh.prototype) as Mesh;
    const lite = { name: "source", material: (material as { _lite: unknown })._lite, children: liteChildren };
    Object.assign(mesh as unknown as Record<string, unknown>, { _lite: lite, _scene: scene, _material: material, _children: [] });
    cloneTransformNodeMock.mockImplementation((src: unknown) => {
        const s = src as { name: string; material?: unknown };
        return { name: s.name + "_clone", material: s.material, children: [...liteChildren] } as never;
    });
    return mesh;
}

describe("Mesh.clone", () => {
    it("forwards the source Lite node to cloneTransformNode and renames to the BJS name", () => {
        cloneTransformNodeMock.mockClear();
        const scene = fakeScene();
        const src = sourceMesh(scene, fakeMaterial());
        const clone = src.clone("copy");

        expect(clone).toBeInstanceOf(Mesh);
        expect(cloneTransformNodeMock).toHaveBeenCalledTimes(1);
        expect(cloneTransformNodeMock.mock.calls[0]![0]).toBe((src as unknown as { _lite: unknown })._lite);
        // Lite hardcodes a "_clone" suffix; the wrapper renames to the given name.
        expect(clone.name).toBe("copy");
        expect((clone as unknown as { _lite: { name: string } })._lite.name).toBe("copy");
    });

    it("keeps the source material and registers the clone with the same scene", () => {
        addToSceneMock.mockClear();
        const scene = fakeScene();
        const material = fakeMaterial();
        const src = sourceMesh(scene, material);
        const clone = src.clone("copy");

        expect(clone.material).toBe(material);
        expect(clone.getScene()).toBe(scene as never);
        expect(addToSceneMock).toHaveBeenCalledTimes(1);
        const call = addToSceneMock.mock.calls[0]!;
        expect(call[0]).toBe(scene._lite);
        expect(call[1]).toBe((clone as unknown as { _lite: unknown })._lite);
    });

    it("clones descendants by default (they are added, not pruned)", () => {
        removeFromSceneMock.mockClear();
        const scene = fakeScene();
        const src = sourceMesh(scene, fakeMaterial(), [{ name: "childA" }, { name: "childB" }]);
        src.clone("copy");
        expect(removeFromSceneMock).not.toHaveBeenCalled();
    });

    it("prunes the cloned descendants when doNotCloneChildren is true", () => {
        removeFromSceneMock.mockClear();
        const scene = fakeScene();
        const childA = { name: "childA" };
        const childB = { name: "childB" };
        const src = sourceMesh(scene, fakeMaterial(), [childA, childB]);
        const clone = src.clone("copy", null, true);

        expect(removeFromSceneMock).toHaveBeenCalledTimes(2);
        expect(removeFromSceneMock.mock.calls.map((c) => c[1])).toEqual([childA, childB]);
        // The clone is left a lone node.
        expect((clone as unknown as { _lite: { children: unknown[] } })._lite.children.length).toBe(0);
    });

    it("reparents the clone to newParent when provided", () => {
        const scene = fakeScene();
        const src = sourceMesh(scene, fakeMaterial());
        const newParent = new TransformNode("parent");

        const clone = src.clone("copy", newParent);
        expect((clone as unknown as { _lite: { parent: unknown } })._lite.parent).toBe((newParent as unknown as { _node: unknown })._node);
    });
});
