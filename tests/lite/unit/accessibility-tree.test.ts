import { describe, expect, it } from "vitest";
import {
    addAccessibilityNode,
    batchAccessibilityUpdates,
    createAccessibilityTree,
    disposeAccessibilityTree,
    onAccessibilityTreeChanged,
    removeAccessibilityNode,
    updateAccessibilityNode,
} from "../../../packages/babylon-lite/src/accessibility/accessibility-tree";

describe("accessibility tree", () => {
    it("stores immutable descriptive metadata and logical hierarchy", () => {
        const tree = createAccessibilityTree();
        const aria = { "aria-live": "polite", "aria-atomic": true };
        const group = addAccessibilityNode(tree, { tag: { name: "Planets", role: "group" } });
        const mars = addAccessibilityNode(tree, {
            parent: group,
            tag: { name: "Mars", description: "The fourth planet", role: "img", aria },
        });

        aria["aria-live"] = "assertive";

        expect(tree.roots).toEqual([group]);
        expect(group.children).toEqual([mars]);
        expect(mars.tag).toEqual({
            name: "Mars",
            description: "The fourth planet",
            role: "img",
            aria: { "aria-live": "polite", "aria-atomic": true },
        });
        expect(Object.isFrozen(mars.tag)).toBe(true);
        expect(Object.isFrozen(mars.tag?.aria)).toBe(true);
    });

    it("replaces and removes semantics without changing node identity", () => {
        const tree = createAccessibilityTree();
        const first = addAccessibilityNode(tree, { tag: { name: "First" } });
        const second = addAccessibilityNode(tree, { tag: { name: "Second" } });

        updateAccessibilityNode(tree, second, {
            parent: first,
            tag: { name: "Updated", role: "heading", aria: { "aria-level": 2 } },
        });

        expect(second.parent).toBe(first);
        expect(second.tag).toEqual({ name: "Updated", role: "heading", aria: { "aria-level": 2 } });

        updateAccessibilityNode(tree, second, { parent: null, tag: null });
        expect(tree.roots).toEqual([first, second]);
        expect(second.tag).toBeNull();
        expect(second.hidden).toBe(false);

        updateAccessibilityNode(tree, second, { tag: { aria: { "aria-hidden": true } } });
        expect(second.hidden).toBe(true);
        updateAccessibilityNode(tree, second, { tag: null });
        expect(second.hidden).toBe(false);
    });

    it("rejects malformed ARIA and conflicting availability before publication", () => {
        const tree = createAccessibilityTree();
        expect(() => addAccessibilityNode(tree, { tag: { aria: { label: "Invalid" } as never } })).toThrow(/aria/i);
        expect(() => addAccessibilityNode(tree, { hidden: true, tag: { aria: { "aria-hidden": false } } })).toThrow(/conflict/i);
        expect(() => addAccessibilityNode(tree, { disabled: false, tag: { disabled: true } })).toThrow(/conflict/i);
        expect(tree.roots).toEqual([]);
    });

    it("coalesces updates and releases descendants on removal and disposal", () => {
        const tree = createAccessibilityTree();
        const parent = addAccessibilityNode(tree, {});
        const child = addAccessibilityNode(tree, { parent });
        let notifications = 0;
        onAccessibilityTreeChanged(tree, () => notifications++);

        batchAccessibilityUpdates(tree, () => {
            updateAccessibilityNode(tree, parent, { tag: { name: "Parent" } });
            updateAccessibilityNode(tree, child, { tag: { name: "Child" } });
        });
        expect(notifications).toBe(1);

        removeAccessibilityNode(tree, parent);
        expect(tree.roots).toEqual([]);
        expect(child.parent).toBeNull();

        disposeAccessibilityTree(tree);
        expect(tree.disposed).toBe(true);
        expect(() => addAccessibilityNode(tree, {})).toThrow(/disposed/i);
    });

    it("does not notify for an unchanged node update", () => {
        const tree = createAccessibilityTree();
        const target = {};
        const node = addAccessibilityNode(tree, {
            tag: { name: "Mars", role: "img", aria: { "aria-level": 2, "aria-busy": false } },
            hidden: false,
            disabled: true,
            target,
        });
        let notifications = 0;
        onAccessibilityTreeChanged(tree, () => notifications++);

        updateAccessibilityNode(tree, node, {
            tag: { name: "Mars", role: "img", aria: { "aria-level": 2, "aria-busy": false } },
            parent: null,
            hidden: false,
            disabled: true,
            target,
        });

        expect(notifications).toBe(0);
    });

    it("publishes the final disposed state to batched observers before releasing them", () => {
        const tree = createAccessibilityTree();
        addAccessibilityNode(tree, { tag: { name: "Before disposal" } });
        const failure = new Error("observer failed");
        const states: Array<{ disposed: boolean; roots: number }> = [];
        onAccessibilityTreeChanged(tree, () => {
            throw failure;
        });
        onAccessibilityTreeChanged(tree, () => {
            states.push({ disposed: tree.disposed, roots: tree.roots.length });
        });

        expect(() =>
            batchAccessibilityUpdates(tree, () => {
                disposeAccessibilityTree(tree);
            })
        ).toThrow(failure);

        expect(states).toEqual([{ disposed: true, roots: 0 }]);
        expect(tree._listeners.size).toBe(0);
        expect(tree._dirty).toBe(false);
        expect(tree._batchDepth).toBe(0);
    });
});
