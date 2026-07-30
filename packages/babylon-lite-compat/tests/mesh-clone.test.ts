import { describe, expect, it, vi } from "vitest";

/**
 * `Mesh.clone(name, newParent?, doNotCloneChildren?)` (issue #473) forwards to
 * Lite's `cloneTransformNode` — which shares the ref-counted geometry with the
 * clone — then renames the clone (Lite hardcodes a `_clone` suffix), keeps the
 * source material, and registers it with the same compat scene through its own
 * wrapper. The real clone needs a GPU device, so these tests mock the Lite scene
 * functions and assert the pure forwarding/translation contract.
 */
vi.mock("babylon-lite", () => {
    const createTransformNode = (name: string) => ({
        name,
        children: [],
        position: { x: 0, y: 0, z: 0, set: vi.fn() },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1, set: vi.fn() },
        rotation: { x: 0, y: 0, z: 0, set: vi.fn() },
        scaling: { x: 1, y: 1, z: 1, set: vi.fn() },
        parent: null,
        worldMatrix: new Float32Array(16),
        worldMatrixVersion: 0,
    });
    return {
        addToScene: vi.fn(),
        removeFromScene: vi.fn(),
        setMeshVisible: vi.fn(),
        createBox: vi.fn(),
        createSphere: vi.fn(),
        createGround: vi.fn(),
        createPlane: vi.fn(),
        createCylinder: vi.fn(),
        createTorus: vi.fn(),
        createTorusKnot: vi.fn(),
        createDisc: vi.fn(),
        createPolyhedron: vi.fn(),
        createRibbon: vi.fn(),
        createTube: vi.fn(),
        createExtrudeShape: vi.fn(),
        createTransformNode,
        cloneTransformNode: vi.fn((src: { name: string; material?: unknown }, children: unknown[] = []) => ({
            name: src.name + "_clone",
            material: src.material,
            children,
            visible: true,
        })),
        setParent: vi.fn(),
        setThinInstances: vi.fn(),
        setThinInstanceColors: vi.fn(),
        createMeshFromData: vi.fn(),
        resizeMeshGeometry: vi.fn(),
        updateMeshUvs: vi.fn(),
        createGroundFromHeightMap: vi.fn(),
        computeAabb: vi.fn(),
    };
});

import { cloneTransformNode, addToScene, removeFromScene } from "babylon-lite";
import { Mesh, TransformNode } from "../src/meshes/meshes";

const cloneTransformNodeMock = vi.mocked(cloneTransformNode);
const addToSceneMock = vi.mocked(addToScene);
const removeFromSceneMock = vi.mocked(removeFromScene);

/** Minimal compat `Scene` stand-in exposing only what `Mesh.clone` touches. */
function fakeScene(): {
    _lite: object;
    registered: unknown[];
    getEngine(): { _lite: object };
    defaultMaterial: null;
    _deferAdd(add: () => void): void;
    _registerMesh(mesh: unknown): void;
} {
    const engine = { _lite: {} };
    const registered: unknown[] = [];
    return {
        _lite: { tag: "scene-lite" },
        registered,
        getEngine: () => engine,
        defaultMaterial: null,
        // The mesh under test is created after engine start, so run adds inline.
        _deferAdd: (add: () => void) => add(),
        _registerMesh: (mesh: unknown) => registered.push(mesh),
    };
}

/** A fake compat material carrying the Lite handle + renderable hook the add path calls. */
function fakeMaterial(): { _lite: object; _ensureRenderable: () => void } {
    return { _lite: { tag: "mat-lite" }, _ensureRenderable: vi.fn() };
}

/** Build a source `Mesh` wrapper without the GPU-backed constructor path. */
function sourceMesh(scene: ReturnType<typeof fakeScene>, material: unknown, liteChildren: unknown[] = []): Mesh {
    const mesh = Object.create(Mesh.prototype) as Mesh;
    const lite = { name: "source", material: (material as { _lite: unknown })._lite, _gpu: {}, children: liteChildren, visible: true };
    Object.assign(mesh as unknown as Record<string, unknown>, {
        name: "source",
        id: "source-id",
        metadata: null,
        _lite: lite,
        _scene: scene,
        _material: material,
        _children: [],
        _enabled: true,
        _parentEnabled: true,
        _visible: true,
    });
    cloneTransformNodeMock.mockImplementation((src: unknown) => {
        const s = src as { name: string; material?: unknown };
        return {
            ...s,
            name: s.name + "_clone",
            visible: true,
            children: liteChildren.map((child) => ({ ...(child as object), children: [] })),
        } as never;
    });
    return mesh;
}

function liteMesh(name: string): object {
    return { name, material: {}, _gpu: {}, visible: true };
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
        const src = sourceMesh(scene, fakeMaterial(), [liteMesh("childA"), liteMesh("childB")]);
        const clone = src.clone("copy");
        expect(removeFromSceneMock).not.toHaveBeenCalled();
        expect(clone.getChildMeshes()).toHaveLength(2);
        expect(scene.registered).toContain(clone.getChildMeshes()[0]);
        expect(scene.registered).toContain(clone.getChildMeshes()[1]);
    });

    it("wraps non-mesh descendants as TransformNode rather than Mesh", () => {
        const scene = fakeScene();
        const sourceMaterial = fakeMaterial();
        const litePivot = { name: "pivot" };
        const liteChildMesh = liteMesh("childMesh");
        const src = sourceMesh(scene, fakeMaterial(), [litePivot, liteChildMesh]);
        const unrelated = new TransformNode("unrelated", undefined, { name: "unrelated" } as never);
        const sourcePivot = new TransformNode("pivot", undefined, litePivot as never);
        const sourceChildMesh = new Mesh("childMesh", liteChildMesh as never);
        sourcePivot.metadata = { kind: "pivot" };
        sourceChildMesh.material = sourceMaterial as never;
        unrelated.parent = src;
        sourcePivot.parent = src;
        sourceChildMesh.parent = src;

        const clone = src.clone("copy");

        const children = clone.getChildren();
        expect(children[0]).toBeInstanceOf(TransformNode);
        expect(children[0]).not.toBeInstanceOf(Mesh);
        expect(children[0]!.metadata).toEqual({ kind: "pivot" });
        expect(children[1]).toBeInstanceOf(Mesh);
        expect((children[1] as Mesh).material).toBe(sourceMaterial);
        expect(clone.getChildMeshes()).toEqual([children[1]]);
        expect(scene.registered).not.toContain(children[0]);
        expect(scene.registered).toContain(children[1]);
    });

    it("prunes the cloned descendants when doNotCloneChildren is true", () => {
        removeFromSceneMock.mockClear();
        const scene = fakeScene();
        const childA = { name: "childA" };
        const childB = { name: "childB" };
        const src = sourceMesh(scene, fakeMaterial(), [childA, childB]);
        const clone = src.clone("copy", null, true);

        expect(removeFromSceneMock).toHaveBeenCalledTimes(2);
        expect(removeFromSceneMock.mock.calls.map((c) => (c[1] as { name: string }).name)).toEqual(["childA", "childB"]);
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

    it("copies wrapper state and retains the source parent by default", () => {
        const scene = fakeScene();
        const src = sourceMesh(scene, fakeMaterial());
        const parent = new TransformNode("parent");
        Object.assign(src as unknown as Record<string, unknown>, { _parent: parent });
        (parent as unknown as { _children: Mesh[] })._children.push(src);
        src.id = "custom-id";
        src.metadata = { tag: "metadata" };
        Object.assign(src as unknown as Record<string, unknown>, { _enabled: false, _visible: false });

        const clone = src.clone("copy");

        expect(clone.parent).toBe(parent);
        expect(clone.id).toBe("copy");
        expect(clone.metadata).toBe(src.metadata);
        expect(clone.isEnabled(false)).toBe(false);
        expect(clone.isVisible).toBe(false);
    });

    it("keeps the Lite default clone name when name is omitted or empty", () => {
        const scene = fakeScene();
        const src = sourceMesh(scene, fakeMaterial());

        expect(src.clone().name).toBe("source_clone");
        expect(src.clone("").name).toBe("source_clone");
    });

    it("detaches from the source parent when newParent is explicitly null", () => {
        const scene = fakeScene();
        const src = sourceMesh(scene, fakeMaterial());
        const parent = new TransformNode("parent");
        Object.assign(src as unknown as Record<string, unknown>, { _parent: parent });
        (parent as unknown as { _children: Mesh[] })._children.push(src);

        const clone = src.clone("copy", null);

        expect(clone.parent).toBeNull();
        expect((clone as unknown as { _lite: { parent: unknown } })._lite.parent).toBeNull();
    });
});
