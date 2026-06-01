import { describe, it, expect } from "vitest";

import { createSceneNode } from "../../packages/babylon-lite/src/scene/scene-node";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera";

describe("world matrix parent propagation", () => {
    it("bumps a child's worldMatrixVersion when an ancestor's transform changes", () => {
        const parent = createSceneNode("parent");
        const child = createSceneNode("child");
        child.parent = parent;

        // Establish baseline versions (simulates a per-frame consumer that
        // gates UBO uploads on worldMatrixVersion and only reads worldMatrix
        // when the version changed).
        const v0 = child.worldMatrixVersion;

        // Animate ONLY the parent — nothing reads the child's worldMatrix.
        parent.rotation.y = Math.PI / 2;

        const v1 = child.worldMatrixVersion;
        expect(v1).not.toBe(v0);

        // Stable once nothing changes again.
        expect(child.worldMatrixVersion).toBe(v1);
    });

    it("propagates an ancestor change through a multi-level hierarchy", () => {
        const root = createSceneNode("root");
        const mid = createSceneNode("mid");
        const leaf = createSceneNode("leaf");
        mid.parent = root;
        leaf.parent = mid;

        const v0 = leaf.worldMatrixVersion;

        root.position.set(5, 0, 0);

        const v1 = leaf.worldMatrixVersion;
        expect(v1).not.toBe(v0);

        // The leaf's world matrix reflects the ancestor translation.
        expect(leaf.worldMatrix[12]).toBeCloseTo(5);
    });

    it("does not bump the version on repeated reads when nothing changes", () => {
        const parent = createSceneNode("parent");
        const child = createSceneNode("child");
        child.parent = parent;

        const v0 = child.worldMatrixVersion;
        expect(child.worldMatrixVersion).toBe(v0);
        expect(child.worldMatrixVersion).toBe(v0);
    });

    it("propagates an ancestor change through a static intermediate node", () => {
        // root → mid (never animated) → leaf (never animated). Animating only the
        // root must still surface on the leaf's version even though the
        // intermediate node's own local transform never changed.
        const root = createSceneNode("root");
        const mid = createSceneNode("mid");
        const leaf = createSceneNode("leaf");
        mid.parent = root;
        leaf.parent = mid;

        const midV0 = mid.worldMatrixVersion;
        const leafV0 = leaf.worldMatrixVersion;

        root.rotation.y = 1.0;

        expect(mid.worldMatrixVersion).not.toBe(midV0);
        expect(leaf.worldMatrixVersion).not.toBe(leafV0);
    });

    it("bumps the leaf version on EVERY ancestor move (no stale skips)", () => {
        // A consumer that only reads versions (never worldMatrix) must observe a
        // fresh version on each successive ancestor move, frame after frame.
        const root = createSceneNode("root");
        const leaf = createSceneNode("leaf");
        leaf.parent = root;

        let prev = leaf.worldMatrixVersion;
        for (let i = 1; i <= 5; i++) {
            root.position.set(i, 0, 0);
            const next = leaf.worldMatrixVersion;
            expect(next).not.toBe(prev);
            prev = next;
        }
    });

    it("reparenting bumps the version and reflects the new parent transform", () => {
        const a = createSceneNode("a");
        const b = createSceneNode("b");
        const child = createSceneNode("child");
        a.position.set(10, 0, 0);
        b.position.set(0, 20, 0);

        child.parent = a;
        expect(child.worldMatrix[12]).toBeCloseTo(10);
        const vA = child.worldMatrixVersion;

        child.parent = b;
        expect(child.worldMatrixVersion).not.toBe(vA);
        expect(child.worldMatrix[12]).toBeCloseTo(0);
        expect(child.worldMatrix[13]).toBeCloseTo(20);

        // After detaching, a former parent's motion no longer affects the child.
        child.parent = null;
        const vDetached = child.worldMatrixVersion;
        b.position.set(0, 99, 0);
        expect(child.worldMatrixVersion).toBe(vDetached);
    });

    it("propagates a camera-parented chain to a leaf with no per-frame reader", () => {
        // camera → mid (pure transform, never read) → leaf. Moving the camera must
        // surface on the leaf even though nothing reads the intermediate node.
        const camera = createFreeCamera({ x: 0, y: 0, z: -10 } as never, { x: 0, y: 0, z: 0 } as never);
        const mid = createSceneNode("mid");
        const leaf = createSceneNode("leaf");
        mid.parent = camera;
        leaf.parent = mid;

        const leafV0 = leaf.worldMatrixVersion;
        camera.position.set(5, 0, -10);
        expect(leaf.worldMatrixVersion).not.toBe(leafV0);
    });
});
