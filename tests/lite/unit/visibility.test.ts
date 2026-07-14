import { describe, expect, it } from "vitest";

import { _vis } from "../../../packages/babylon-lite/src/engine/engine";
import { createSceneNode } from "../../../packages/babylon-lite/src/scene/scene-node";
import { setSubtreeVisible } from "../../../packages/babylon-lite/src/scene/visibility";

describe("setSubtreeVisible", () => {
    it("cascades visibility and bumps the epoch once", () => {
        const root = createSceneNode("root");
        const child = createSceneNode("child");
        root.children.push(child);
        const initialEpoch = _vis;

        setSubtreeVisible(root, false);

        expect(root.visible).toBe(false);
        expect(child.visible).toBe(false);
        expect(_vis).toBe((initialEpoch + 1) | 0);
    });

    it("skips identical writes but detects a changed descendant", () => {
        const root = createSceneNode("root");
        const child = createSceneNode("child");
        root.children.push(child);
        setSubtreeVisible(root, false);
        const stableEpoch = _vis;

        setSubtreeVisible(root, false);
        expect(_vis).toBe(stableEpoch);

        child.visible = true;
        setSubtreeVisible(root, false);
        expect(child.visible).toBe(false);
        expect(_vis).toBe((stableEpoch + 1) | 0);
    });
});
