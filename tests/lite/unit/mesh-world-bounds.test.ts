import { describe, expect, it } from "vitest";

import { computeSceneSize } from "../../../packages/babylon-lite/src/material/pbr/scene-size";
import { enableThinInstanceWorldBounds } from "../../../packages/babylon-lite/src/mesh/enable-thin-instance-world-bounds";
import { emptyWorldAabb, expandWorldAabbForMesh } from "../../../packages/babylon-lite/src/mesh/mesh-world-bounds";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function mesh(worldMatrix: number[], matrices?: number[]): Mesh {
    const result = {
        boundMin: [-1, -2, -3],
        boundMax: [1, 2, 3],
        worldMatrix,
    } as unknown as Mesh;
    if (matrices) {
        setThinInstances(result, new Float32Array(matrices), matrices.length / 16);
        enableThinInstanceWorldBounds(result);
    }
    return result;
}

describe("mesh world bounds", () => {
    it("applies the complete mesh world matrix", () => {
        const acc = emptyWorldAabb();
        expandWorldAabbForMesh(acc, mesh([0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1]));

        expect(acc).toEqual({
            minX: 4,
            minY: 18,
            minZ: 18,
            maxX: 16,
            maxY: 22,
            maxZ: 42,
        });
    });

    it("composes thin-instance matrices before the prototype world matrix", () => {
        const acc = emptyWorldAabb();
        expandWorldAabbForMesh(
            acc,
            mesh([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1])
        );

        expect(acc.minX).toBe(-2);
        expect(acc.maxX).toBe(22);
        expect(acc.minY).toBe(-4);
        expect(acc.maxY).toBe(4);
    });

    it("ignores parked thin instances with a degenerate linear transform", () => {
        const acc = emptyWorldAabb();
        expandWorldAabbForMesh(
            acc,
            mesh([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1_000_000, 0, 0, 1])
        );

        expect(acc.minX).toBe(4);
        expect(acc.maxX).toBe(6);
    });

    it("uses transformed and instanced bounds for environment sizing", () => {
        const scene = {
            meshes: [mesh([10, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1])],
            camera: null,
        } as unknown as SceneContext;

        const size = computeSceneSize(scene);

        expect(size.rootPosition).toEqual([10, -2.00001, 0]);
        expect(size.groundSize).toBeCloseTo(Math.sqrt(400 + 16 + 36) * 2 * 1.1);
        expect(size.skyboxSize).toBeCloseTo(Math.sqrt(400 + 16 + 36) * 2 * 1.5);
    });
});
