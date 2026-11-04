import { beforeEach, describe, expect, it, vi } from "vitest";

const { setAccessibilityTagMock } = vi.hoisted(() => ({
    setAccessibilityTagMock: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    setAccessibilityTagMock.mockImplementation(actual.setAccessibilityTag);
    return {
        ...actual,
        setAccessibilityTag: setAccessibilityTagMock,
    };
});

import { getAccessibilityTag } from "babylon-lite";
import { LiteCompatError } from "../src/error";
import type { IAccessibilityTag } from "../src/node/node";
import { Node } from "../src/node/node";

class BackedNode extends Node {
    /** @internal */
    public readonly _lite = { name: "backed-node" };

    public constructor() {
        super("backed-node");
    }
}

describe("Node accessibility", () => {
    beforeEach(() => {
        setAccessibilityTagMock.mockClear();
    });

    it("forwards description, role, and ARIA metadata to Lite", () => {
        const node = new BackedNode();
        const changes: Array<IAccessibilityTag | null> = [];
        const tag: IAccessibilityTag = {
            description: "Opens settings",
            role: "dialog",
            aria: {
                "aria-label": "Settings",
                "aria-modal": true,
                "aria-details": { id: "settings-details" },
            } as NonNullable<IAccessibilityTag["aria"]>,
        };
        node.onAccessibilityTagChangedObservable.add((value) => changes.push(value));

        node.accessibilityTag = tag;

        expect(setAccessibilityTagMock).toHaveBeenCalledWith(node._lite, {
            description: "Opens settings",
            role: "dialog",
            aria: {
                "aria-label": "Settings",
                "aria-modal": true,
                "aria-details": "[object Object]",
            },
        });
        expect(node.accessibilityTag).toBe(tag);
        expect(changes).toEqual([tag]);

        node.accessibilityTag = null;
        expect(setAccessibilityTagMock).toHaveBeenLastCalledWith(node._lite, null);
        expect(changes).toEqual([tag, null]);
    });

    it("rejects event handlers because Lite has no listener lifecycle seam", () => {
        const node = new BackedNode();

        expect(() => {
            node.accessibilityTag = {
                eventHandler: { click: () => undefined } as NonNullable<IAccessibilityTag["eventHandler"]>,
            };
        }).toThrow(LiteCompatError);
        expect(setAccessibilityTagMock).not.toHaveBeenCalled();
    });

    it("stores and notifies before a Lite forwarding failure", () => {
        const node = new BackedNode();
        const tag: IAccessibilityTag = { description: "Retained" };
        const changes: Array<IAccessibilityTag | null> = [];
        node.onAccessibilityTagChangedObservable.add((value) => changes.push(value));
        setAccessibilityTagMock.mockImplementationOnce(() => {
            throw new Error("Lite rejected metadata");
        });

        expect(() => {
            node.accessibilityTag = tag;
        }).toThrow("Lite rejected metadata");
        expect(node.accessibilityTag).toBe(tag);
        expect(changes).toEqual([tag]);
    });

    it("does not let a superseded re-entrant assignment overwrite Lite metadata", () => {
        const node = new BackedNode();
        node.onAccessibilityTagChangedObservable.addOnce(() => {
            node.accessibilityTag = null;
        });

        node.accessibilityTag = { description: "Superseded" };

        expect(node.accessibilityTag).toBeNull();
        expect(getAccessibilityTag(node._lite)).toBeNull();
    });
});
