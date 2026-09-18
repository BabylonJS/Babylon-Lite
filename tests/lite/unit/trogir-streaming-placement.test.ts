import { describe, expect, it } from "vitest";

import { placeTrogirStream } from "../../../lab/lite/src/demos/trogir-streaming-placement";
import { initSceneNodeTransform } from "../../../packages/babylon-lite/src/scene/scene-node";
import type { GaussianSplatStream } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types";

function transformCovariance(matrix: ArrayLike<number>, covariance: readonly number[]): number[][] {
    const a = [
        [matrix[0]!, matrix[4]!, matrix[8]!],
        [matrix[1]!, matrix[5]!, matrix[9]!],
        [matrix[2]!, matrix[6]!, matrix[10]!],
    ];
    const c = [
        [covariance[0]!, covariance[1]!, covariance[2]!],
        [covariance[1]!, covariance[3]!, covariance[4]!],
        [covariance[2]!, covariance[4]!, covariance[5]!],
    ];
    return a.map((row) => a.map((_, j) => row.reduce((sum, value, k) => sum + value * c[k]!.reduce((inner, component, l) => inner + component * a[j]![l]!, 0), 0)));
}

describe("Trogir streaming placement", () => {
    it("applies the published viewer orientation to asymmetric bounds and covariance", () => {
        const stream = initSceneNodeTransform<GaussianSplatStream>({
            name: "Trogir test stream",
            children: [],
            boundMin: [-73.73801, -28.03207, -180.688],
            boundMax: [80.23741, 3.942674, 17.55537],
        });

        const target = placeTrogirStream(stream);

        expect(stream.rotation.z).toBe(Math.PI);
        expect(target.x).toBeCloseTo(-3.2497, 4);
        expect(target.y).toBeCloseTo(12.044698, 4);
        expect(target.z).toBeCloseTo(-81.566315, 4);
        const transformed = transformCovariance(stream.worldMatrix, [4, 1, 2, 3, -0.5, 2]);
        expect(transformed[0]![0]).toBeCloseTo(4);
        expect(transformed[0]![1]).toBeCloseTo(1);
        expect(transformed[0]![2]).toBeCloseTo(-2);
        expect(transformed[1]![0]).toBeCloseTo(1);
        expect(transformed[1]![1]).toBeCloseTo(3);
        expect(transformed[1]![2]).toBeCloseTo(0.5);
        expect(transformed[2]![0]).toBeCloseTo(-2);
        expect(transformed[2]![1]).toBeCloseTo(0.5);
        expect(transformed[2]![2]).toBeCloseTo(2);
    });
});
