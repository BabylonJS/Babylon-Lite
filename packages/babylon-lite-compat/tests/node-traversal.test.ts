import { beforeEach, describe, expect, it, vi } from "vitest";

const { addToSceneMock, createMeshFromDataMock, removeFromSceneMock } = vi.hoisted(() => ({
    addToSceneMock: vi.fn(),
    createMeshFromDataMock: vi.fn((_: unknown, name: string) => ({
        name,
        visible: true,
        children: [],
        receiveShadows: false,
    })),
    removeFromSceneMock: vi.fn(function removeFromScene(scene: unknown, node: { children?: unknown[] }) {
        for (const child of [...(node.children ?? [])]) {
            removeFromSceneMock(scene, child as { children?: unknown[] });
        }
    }),
}));

vi.mock("babylon-lite", async (importActual) => ({
    ...(await importActual<typeof import("babylon-lite")>()),
    addToScene: addToSceneMock,
    createMeshFromData: createMeshFromDataMock,
    removeFromScene: removeFromSceneMock,
}));

import type { Mesh as LiteMesh } from "babylon-lite";
import { AbstractMesh, Mesh, TransformNode } from "../src/meshes/meshes";
import { Node } from "../src/node/node";
import type { Scene } from "../src/scene/scene";

/**
 * GPU-free tests for the `Node` scene-graph traversal API
 * (`getDescendants` / `getChildren` / `getChildMeshes`) and the child registry
 * maintained by the `parent` setter. A tiny concrete subclass stands in for the
 * real `Mesh`/`Camera`/`Light` wrappers so the traversal logic is exercised
 * without a WebGPU device.
 */
class TestNode extends Node {
    public constructor(
        name: string,
        private readonly _mesh = false
    ) {
        super(name);
    }
    protected override _isMeshNode(): boolean {
        return this._mesh;
    }
}

function createTestMesh(name: string, onChildrenRead?: () => void, scene?: Scene): AbstractMesh {
    const children: LiteMesh[] = [];
    const lite = { name, visible: true, children, receiveShadows: false } as unknown as LiteMesh;
    if (onChildrenRead) {
        Object.defineProperty(lite, "children", {
            get: () => {
                onChildrenRead();
                return children;
            },
        });
    }
    return new AbstractMesh(name, lite, scene);
}

function createTestScene(): { scene: Scene; registered: Node[]; pendingAdds: Array<() => void> } {
    const registered: Node[] = [];
    const pendingAdds: Array<() => void> = [];
    const scene = {
        _lite: { id: "scene" },
        defaultMaterial: null,
        getEngine: () => ({ _lite: { id: "engine" } }),
        _deferAdd: (add: () => void) => pendingAdds.push(add),
        _registerMesh: (node: Node) => registered.push(node),
        _unregisterNode: (node: Node) => {
            const index = registered.indexOf(node);
            if (index !== -1) {
                registered.splice(index, 1);
            }
        },
    } as unknown as Scene;
    return { scene, registered, pendingAdds };
}

describe("Node scene-graph traversal", () => {
    beforeEach(() => {
        addToSceneMock.mockClear();
        createMeshFromDataMock.mockClear();
        removeFromSceneMock.mockClear();
    });

    it("maintains the child registry as parent links change", () => {
        const root = new TestNode("root");
        const a = new TestNode("a");
        const b = new TestNode("b");
        a.parent = root;
        b.parent = root;
        expect(root.getChildren()).toEqual([a, b]);
        expect(a.parent).toBe(root);

        // Reparenting removes the child from its previous parent.
        b.parent = a;
        expect(root.getChildren()).toEqual([a]);
        expect(a.getChildren()).toEqual([b]);

        // Clearing the parent detaches it from both sides.
        b.parent = null;
        expect(a.getChildren()).toEqual([]);
        expect(b.parent).toBeNull();
    });

    it("getDescendants walks the whole subtree (or only direct children)", () => {
        const root = new TestNode("root");
        const child = new TestNode("child");
        const grandchild = new TestNode("grandchild");
        child.parent = root;
        grandchild.parent = child;

        expect(root.getDescendants()).toEqual([child, grandchild]);
        expect(root.getDescendants(true)).toEqual([child]);
        expect(root.getDescendants(false, (n) => n.name === "grandchild")).toEqual([grandchild]);
    });

    it("getChildMeshes returns only mesh descendants", () => {
        const root = new TestNode("root");
        const meshChild = new TestNode("mesh", true);
        const plainChild = new TestNode("plain", false);
        const nestedMesh = new TestNode("nested", true);
        meshChild.parent = root;
        plainChild.parent = root;
        nestedMesh.parent = plainChild;

        // All mesh descendants (default), then direct-only.
        expect(root.getChildMeshes()).toEqual([meshChild, nestedMesh]);
        expect(root.getChildMeshes(true)).toEqual([meshChild]);
    });

    it("dispose detaches a node from its parent's children", () => {
        const root = new TestNode("root");
        const child = new TestNode("child");
        child.parent = root;
        expect(root.getChildren()).toEqual([child]);

        child.dispose();
        expect(root.getChildren()).toEqual([]);
        expect(child.isDisposed()).toBe(true);
    });

    it("recursively removes every transform and mesh through the compat hierarchy", () => {
        const { scene, registered } = createTestScene();
        const root = new TransformNode("root", scene);
        const child = createTestMesh("child", undefined, scene);
        const grandchild = createTestMesh("grandchild", undefined, scene);
        child.parent = root;
        grandchild.parent = child;
        const disposed: string[] = [];
        for (const node of [root, child, grandchild]) {
            node.onDisposeObservable.add(({ name }) => disposed.push(name));
        }

        root.dispose();

        expect(removeFromSceneMock.mock.calls.map(([, node]) => node)).toEqual([grandchild._node, child._node, root._node]);
        expect(registered).toEqual([]);
        expect([root, child, grandchild].every((node) => node.isDisposed())).toBe(true);
        expect(child.parent).toBeNull();
        expect(grandchild.parent).toBeNull();
        expect(disposed).toEqual(["grandchild", "child", "root"]);

        root.dispose();
        expect(removeFromSceneMock).toHaveBeenCalledTimes(3);
        expect(disposed).toHaveLength(3);
    });

    it("recursively removes descendants absent from a mesh root's Lite children", () => {
        const { scene } = createTestScene();
        const root = createTestMesh("root", undefined, scene);
        const child = new TransformNode("child", scene);
        const grandchild = createTestMesh("grandchild", undefined, scene);
        child.parent = root;
        grandchild.parent = child;

        expect(root._node.children).toEqual([]);
        root.dispose();

        expect(removeFromSceneMock.mock.calls.map(([, node]) => node)).toEqual([grandchild._node, child._node, root._node]);
    });

    it("dispose(true) removes only the root and detaches native and compat descendants", () => {
        const { scene, registered } = createTestScene();
        const root = new TransformNode("root", scene);
        const child = createTestMesh("child", undefined, scene);
        child.parent = root;
        root._node.children.push(child._node);

        root.dispose(true);

        expect(removeFromSceneMock).toHaveBeenCalledOnce();
        expect(removeFromSceneMock).toHaveBeenCalledWith(scene._lite, root._node);
        expect(root._node.children).toEqual([]);
        expect(child._node.parent).toBeNull();
        expect(child.isDisposed()).toBe(false);
        expect(child.parent).toBeNull();
        expect(registered).toEqual([child]);
    });

    it("disposes recursive meshes safely before or after deferred scene registration", () => {
        const before = createTestScene();
        const pendingRoot = new Mesh("pending-root", before.scene);
        const pendingChild = new Mesh("pending-child", before.scene);
        pendingChild.parent = pendingRoot;

        pendingRoot.dispose();
        for (const add of before.pendingAdds) {
            add();
        }
        expect(addToSceneMock).not.toHaveBeenCalled();
        expect(removeFromSceneMock).toHaveBeenCalledTimes(2);

        addToSceneMock.mockClear();
        removeFromSceneMock.mockClear();
        const after = createTestScene();
        const builtRoot = new Mesh("built-root", after.scene);
        const builtChild = new Mesh("built-child", after.scene);
        builtChild.parent = builtRoot;
        for (const add of after.pendingAdds) {
            add();
        }
        expect(addToSceneMock).toHaveBeenCalledTimes(2);

        builtRoot.dispose();
        expect(removeFromSceneMock).toHaveBeenCalledTimes(2);
    });
});

describe("Node enabled hierarchy", () => {
    it("inherits ancestor state without overwriting a descendant's local state", () => {
        const root = new TransformNode("root");
        const group = new TransformNode("group");
        const enabledMesh = createTestMesh("enabled");
        const locallyDisabledMesh = createTestMesh("locally-disabled");
        group.parent = root;
        enabledMesh.parent = group;
        locallyDisabledMesh.parent = group;
        locallyDisabledMesh.setEnabled(false);

        root.setEnabled(false);

        expect(group.isEnabled(false)).toBe(true);
        expect(enabledMesh.isEnabled(false)).toBe(true);
        expect(group.isEnabled()).toBe(false);
        expect(enabledMesh.isEnabled()).toBe(false);
        expect(enabledMesh.isVisible).toBe(true);
        expect(enabledMesh._lite.visible).toBe(false);

        root.setEnabled(true);

        expect(group.isEnabled()).toBe(true);
        expect(enabledMesh.isEnabled()).toBe(true);
        expect(enabledMesh._lite.visible).toBe(true);
        expect(locallyDisabledMesh.isEnabled(false)).toBe(false);
        expect(locallyDisabledMesh.isEnabled()).toBe(false);
        expect(locallyDisabledMesh.isVisible).toBe(true);
        expect(locallyDisabledMesh._lite.visible).toBe(false);
    });

    it("does not retraverse Lite subtrees already cascaded by an ancestor mesh", () => {
        let childrenReads = 0;
        const root = new TransformNode("root");
        const parentMesh = createTestMesh("parent", () => childrenReads++);
        const childMesh = createTestMesh("child", () => childrenReads++);
        const grandchildMesh = createTestMesh("grandchild", () => childrenReads++);
        parentMesh.parent = root;
        childMesh.parent = parentMesh;
        grandchildMesh.parent = childMesh;
        parentMesh._lite.children.push(childMesh._lite);
        childMesh._lite.children.push(grandchildMesh._lite);
        childrenReads = 0;

        root.setEnabled(false);

        expect(childrenReads).toBe(3);
        expect(parentMesh._lite.visible).toBe(false);
        expect(childMesh._lite.visible).toBe(false);
        expect(grandchildMesh._lite.visible).toBe(false);
    });
});
