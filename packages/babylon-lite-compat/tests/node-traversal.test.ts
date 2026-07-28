import { describe, expect, it } from "vitest";

import { Node } from "../src/node/node";

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

describe("Node scene-graph traversal", () => {
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
});

describe("Node enabled-state observables", () => {
    it("isEnabled(false) reports the own flag; the default checks ancestors", () => {
        const root = new TestNode("root");
        const child = new TestNode("child");
        child.parent = root;

        root.setEnabled(false);
        expect(child.isEnabled(false)).toBe(true); // own flag unchanged
        expect(child.isEnabled()).toBe(false); // ancestor disabled → not effectively enabled
        expect(child.isEnabled(true)).toBe(false);
    });

    it("onEnabledStateChangedObservable fires only on the node's own flag change", () => {
        const node = new TestNode("n");
        const seen: boolean[] = [];
        node.onEnabledStateChangedObservable.add((v) => seen.push(v));

        node.setEnabled(false);
        node.setEnabled(false); // no-op, no notification
        node.setEnabled(true);
        expect(seen).toEqual([false, true]);
    });

    it("onEffectiveEnabledStateChangedObservable fires on a node when an ancestor flips it", () => {
        const root = new TestNode("root");
        const child = new TestNode("child");
        child.parent = root;
        const seen: boolean[] = [];
        child.onEffectiveEnabledStateChangedObservable.add((v) => seen.push(v));

        root.setEnabled(false); // child's effective state flips to false
        root.setEnabled(true); // and back to true
        expect(seen).toEqual([false, true]);
    });

    it("the effective observable does not fire when the effective state is unchanged", () => {
        const root = new TestNode("root");
        const child = new TestNode("child");
        child.parent = root;
        child.setEnabled(false); // child already off
        const seen: boolean[] = [];
        child.onEffectiveEnabledStateChangedObservable.add((v) => seen.push(v));

        // Toggling the ancestor cannot change the child's effective state (still off).
        root.setEnabled(false);
        root.setEnabled(true);
        expect(seen).toEqual([]);
    });

    it("lazily allocates the observables (same instance on repeat access)", () => {
        const node = new TestNode("n");
        expect(node.onEnabledStateChangedObservable).toBe(node.onEnabledStateChangedObservable);
        expect(node.onEffectiveEnabledStateChangedObservable).toBe(node.onEffectiveEnabledStateChangedObservable);
    });
});
