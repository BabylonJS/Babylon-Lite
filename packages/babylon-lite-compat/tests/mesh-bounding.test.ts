import { describe, expect, it } from "vitest";
import { createTransformNode } from "babylon-lite";

import { AbstractMesh } from "../src/meshes/meshes";
import { BoundingInfo } from "../src/culling/bounding";
import { LoadedMesh } from "../src/loading/loaded-mesh";

/**
 * `AbstractMesh.getBoundingInfo()` reads only the backing Lite mesh's
 * `boundMin`/`boundMax` (or its retained CPU positions), so it is GPU-free and
 * can be exercised by invoking the prototype against a minimal fake `_lite`.
 */
describe("AbstractMesh.getBoundingInfo", () => {
    const getBounds = (lite: unknown): BoundingInfo => {
        const mesh = Object.create(AbstractMesh.prototype) as AbstractMesh;
        (mesh as unknown as { _lite: unknown })._lite = lite;
        return mesh.getBoundingInfo();
    };

    it("uses Lite boundMin/boundMax when present", () => {
        const info = getBounds({ boundMin: [-1, -2, -3], boundMax: [1, 2, 3] });
        expect(info).toBeInstanceOf(BoundingInfo);
        expect(info.minimum.asArray()).toEqual([-1, -2, -3]);
        expect(info.maximum.asArray()).toEqual([1, 2, 3]);
    });

    it("derives world-space bounds from the Lite mesh world matrix", () => {
        // A mesh at (1,2,3): local bounds unchanged, world bounds offset by it.
        const worldMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
        const info = getBounds({ boundMin: [-1, -1, -1], boundMax: [1, 1, 1], worldMatrix });
        expect(info.minimum.asArray()).toEqual([-1, -1, -1]);
        expect(info.boundingBox.minimumWorld.asArray()).toEqual([0, 1, 2]);
        expect(info.boundingBox.maximumWorld.asArray()).toEqual([2, 3, 4]);
        expect(info.boundingBox.centerWorld.asArray()).toEqual([1, 2, 3]);
    });

    it("pulls the current lazy world matrix, including parent transforms", () => {
        const parent = createTransformNode("parent");
        const mesh = createTransformNode("mesh") as ReturnType<typeof createTransformNode> & { boundMin: [number, number, number]; boundMax: [number, number, number] };
        mesh.boundMin = [-1, -1, -1];
        mesh.boundMax = [1, 1, 1];
        mesh.parent = parent;
        parent.position.set(5, 0, 0);
        mesh.position.set(0, 2, 0);

        const info = getBounds(mesh);
        expect(info.boundingBox.minimumWorld.asArray()).toEqual([4, 1, -1]);
        expect(info.boundingBox.maximumWorld.asArray()).toEqual([6, 3, 1]);
    });

    it("folds CPU positions through computeAabb when bounds are absent", () => {
        const positions = new Float32Array([-2, 0, 0, 4, 1, 0, 0, -3, 5]);
        const info = getBounds({ _cpuPositions: positions });
        expect(info.minimum.asArray()).toEqual([-2, -3, 0]);
        expect(info.maximum.asArray()).toEqual([4, 1, 5]);
    });

    it("returns a degenerate zero box for empty geometry", () => {
        const info = getBounds({});
        expect(info.minimum.asArray()).toEqual([0, 0, 0]);
        expect(info.maximum.asArray()).toEqual([0, 0, 0]);
    });
});

describe("LoadedMesh.getBoundingInfo", () => {
    it("reports loader mesh bounds in both local and current world space", () => {
        const parent = createTransformNode("parent");
        const node = createTransformNode("loaded") as ReturnType<typeof createTransformNode> & { boundMin: [number, number, number]; boundMax: [number, number, number] };
        node.boundMin = [-1, -2, -3];
        node.boundMax = [1, 2, 3];
        node.parent = parent;
        parent.position.set(4, 0, 0);
        node.position.set(0, 5, 0);

        const info = new LoadedMesh(node as never).getBoundingInfo();
        expect(info.minimum.asArray()).toEqual([-1, -2, -3]);
        expect(info.maximum.asArray()).toEqual([1, 2, 3]);
        expect(info.boundingBox.minimumWorld.asArray()).toEqual([3, 3, -3]);
        expect(info.boundingBox.maximumWorld.asArray()).toEqual([5, 7, 3]);
    });
});
