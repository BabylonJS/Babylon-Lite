import { describe, expect, it, vi } from "vitest";

const { alphaBetaGammaMock, eulerMock } = vi.hoisted(() => ({
    alphaBetaGammaMock: vi.fn((_x: number, _y: number, _z: number, _w: number, out: { x: number; y: number; z: number }) => Object.assign(out, { x: 4, y: 5, z: 6 })),
    eulerMock: vi.fn((_x: number, _y: number, _z: number, _w: number, out: { x: number; y: number; z: number }) => Object.assign(out, { x: 1, y: 2, z: 3 })),
}));

vi.mock("babylon-lite", async (importActual) => ({
    ...(await importActual<typeof import("babylon-lite")>()),
    quatToBabylonAlphaBetaGammaToRef: alphaBetaGammaMock,
    quatToBabylonEulerToRef: eulerMock,
}));

import { Quaternion } from "../src/math/quaternion";
import { Vector3 } from "../src/math/vector";

describe("Quaternion Lite forwarding", () => {
    it("forwards Babylon Euler conversion into caller-owned storage", () => {
        const result = new Vector3();
        expect(new Quaternion(0.1, 0.2, 0.3, 0.4).toEulerAnglesToRef(result)).toBe(result);
        expect(eulerMock).toHaveBeenCalledWith(0.1, 0.2, 0.3, 0.4, result);
        expect(result.asArray()).toEqual([1, 2, 3]);
    });

    it("forwards alpha/beta/gamma conversion into caller-owned storage", () => {
        const result = new Vector3();
        expect(new Quaternion(0.1, 0.2, 0.3, 0.4).toAlphaBetaGammaToRef(result)).toBe(result);
        expect(alphaBetaGammaMock).toHaveBeenCalledWith(0.1, 0.2, 0.3, 0.4, result);
        expect(result.asArray()).toEqual([4, 5, 6]);
    });
});
