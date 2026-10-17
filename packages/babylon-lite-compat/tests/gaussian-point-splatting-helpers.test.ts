import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPackedBytesMock, hasProjectedDepthMock } = vi.hoisted(() => ({
    getPackedBytesMock: vi.fn(() => 72),
    hasProjectedDepthMock: vi.fn(() => true),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        getGaussianPointSplattingPackedShBytesPerSplat: getPackedBytesMock,
        hasGaussianPointSplattingProjectedDepth: hasProjectedDepthMock,
    };
});

import { _GetPackedShBytesPerSplat, _HasGaussianPointSplattingProjectedDepth } from "../src/meshes/gaussian-splatting";
import { Matrix } from "../src/math/matrix";

describe("Gaussian Point Splatting helper forwarding", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("forwards the BJS projection wrapper to Lite", () => {
        const projection = Matrix.Identity();

        expect(_HasGaussianPointSplattingProjectedDepth(projection)).toBe(true);
        expect(hasProjectedDepthMock).toHaveBeenCalledWith(projection.m);
    });

    it("forwards the SH degree to Lite", () => {
        expect(_GetPackedShBytesPerSplat(4)).toBe(72);
        expect(getPackedBytesMock).toHaveBeenCalledWith(4);
    });
});
