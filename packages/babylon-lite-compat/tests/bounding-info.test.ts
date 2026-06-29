import { describe, expect, it } from "vitest";

import { AbstractMesh } from "../src/meshes/meshes";
import { BoundingInfo } from "../src/culling/bounding";

/**
 * `AbstractMesh.getBoundingInfo()` reads a mesh's local-space AABB from the Lite
 * mesh's `boundMin`/`boundMax`, falling back to folding the retained CPU position
 * buffer with Lite's `computeAabb`. None of that needs a GPU device, so we drive
 * it against a minimal fake `_lite` adopted onto the prototype.
 */
describe("AbstractMesh.getBoundingInfo", () => {
    function meshWithLite(lite: object): AbstractMesh {
        const mesh = Object.create(AbstractMesh.prototype) as AbstractMesh;
        Object.defineProperty(mesh, "_lite", { value: lite, configurable: true });
        return mesh;
    }

    it("returns the precomputed boundMin/boundMax when present", () => {
        const mesh = meshWithLite({ boundMin: [-1, -2, -3], boundMax: [4, 5, 6] });
        const info = mesh.getBoundingInfo();
        expect(info).toBeInstanceOf(BoundingInfo);
        expect(info.minimum.asArray()).toEqual([-1, -2, -3]);
        expect(info.maximum.asArray()).toEqual([4, 5, 6]);
        // Center/extents derive from the AABB.
        expect(info.boundingBox.center.asArray()).toEqual([1.5, 1.5, 1.5]);
    });

    it("folds the CPU position buffer when bounds were never precomputed", () => {
        // A 1×1×1 corner spread: min (0,0,0), max (1,1,1).
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
        const mesh = meshWithLite({ _cpuPositions: positions });
        const info = mesh.getBoundingInfo();
        expect(info.minimum.asArray()).toEqual([0, 0, 0]);
        expect(info.maximum.asArray()).toEqual([1, 1, 1]);
    });

    it("returns a zero-extent box when the CPU position buffer is not a multiple of 3", () => {
        // A truncated buffer (length 4) would make computeAabb read past the end,
        // leaving Y/Z as Infinity; getBoundingInfo must reject it.
        const positions = new Float32Array([0, 0, 0, 1]);
        const mesh = meshWithLite({ _cpuPositions: positions });
        const info = mesh.getBoundingInfo();
        expect(info.minimum.asArray()).toEqual([0, 0, 0]);
        expect(info.maximum.asArray()).toEqual([0, 0, 0]);
    });

    it("returns a zero-extent box when no bounds or positions exist", () => {
        const mesh = meshWithLite({});
        const info = mesh.getBoundingInfo();
        expect(info.minimum.asArray()).toEqual([0, 0, 0]);
        expect(info.maximum.asArray()).toEqual([0, 0, 0]);
    });
});
