import { describe, expect, it, vi } from "vitest";

const { alphaBetaGammaMock, eulerMock } = vi.hoisted(() => ({
    alphaBetaGammaMock: vi.fn(() => [4, 5, 6] as [number, number, number]),
    eulerMock: vi.fn(() => [1, 2, 3] as [number, number, number]),
}));

vi.mock("babylon-lite", async (importActual) => ({
    ...(await importActual<typeof import("babylon-lite")>()),
    quatToBabylonAlphaBetaGammaTuple: alphaBetaGammaMock,
    quatToBabylonEulerTuple: eulerMock,
}));

import { Quaternion } from "../src/math/quaternion";
import { Vector3 } from "../src/math/vector";

describe("Quaternion Lite forwarding", () => {
    it("forwards Babylon Euler conversion and writes the returned tuple", () => {
        const result = new Vector3();
        expect(new Quaternion(0.1, 0.2, 0.3, 0.4).toEulerAnglesToRef(result)).toBe(result);
        expect(eulerMock).toHaveBeenCalledWith(0.1, 0.2, 0.3, 0.4);
        expect(result.asArray()).toEqual([1, 2, 3]);
    });

    it("forwards alpha/beta/gamma conversion and writes the returned tuple", () => {
        const result = new Vector3();
        expect(new Quaternion(0.1, 0.2, 0.3, 0.4).toAlphaBetaGammaToRef(result)).toBe(result);
        expect(alphaBetaGammaMock).toHaveBeenCalledWith(0.1, 0.2, 0.3, 0.4);
        expect(result.asArray()).toEqual([4, 5, 6]);
    });
});
