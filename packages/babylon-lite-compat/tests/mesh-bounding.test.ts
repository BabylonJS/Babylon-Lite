import { describe, expect, it } from "vitest";

import { AbstractMesh } from "../src/meshes/meshes";
import { BoundingInfo } from "../src/culling/bounding";

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
