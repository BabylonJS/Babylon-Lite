import { beforeEach, describe, expect, it, vi } from "vitest";

const { writeLookDirectionLHMock, writeLookDirectionRHMock, writeQuatMock } = vi.hoisted(() => ({
    writeLookDirectionLHMock: vi.fn((out: Float32Array) => {
        out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        return out;
    }),
    writeLookDirectionRHMock: vi.fn((out: Float32Array) => {
        out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        return out;
    }),
    writeQuatMock: vi.fn((_matrix: Float32Array, out: { x: number; y: number; z: number; w: number }) => {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        out.w = 1;
        return out;
    }),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        writeMat4FromLookDirectionLHIntoBuffer: writeLookDirectionLHMock,
        writeMat4FromLookDirectionRHIntoBuffer: writeLookDirectionRHMock,
        writeQuatFromRotationMat4IntoRef: writeQuatMock,
    };
});

import { Matrix } from "../src/math/matrix";
import { Quaternion } from "../src/math/quaternion";
import { Vector3 } from "../src/math/vector";

describe("look-direction forwarding", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("forwards Matrix LookDirection inputs and preserves ToRef identity", () => {
        const forward = new Vector3(1, 0, 0);
        const up = Vector3.Up();
        const lh = new Matrix();
        const rh = new Matrix();

        expect(Matrix.LookDirectionLHToRef(forward, up, lh)).toBe(lh);
        expect(writeLookDirectionRHMock).toHaveBeenCalledWith(lh.m, forward, up);
        expect(Matrix.LookDirectionRHToRef(forward, up, rh)).toBe(rh);
        expect(writeLookDirectionLHMock).toHaveBeenCalledWith(rh.m, forward, up);
    });

    it("forwards Quaternion LookDirection inputs through Lite and preserves ToRef identity", () => {
        const forward = new Vector3(1, 0, 0);
        const up = Vector3.Up();
        const lh = new Quaternion();
        const rh = new Quaternion();

        expect(Quaternion.FromLookDirectionLHToRef(forward, up, lh)).toBe(lh);
        expect(writeLookDirectionRHMock).toHaveBeenCalledWith(expect.any(Float32Array), forward, up);
        expect(writeQuatMock).toHaveBeenCalledWith(expect.any(Float32Array), lh);
        expect(lh.asArray()).toEqual([0, 0, 0, 1]);

        expect(Quaternion.FromLookDirectionRHToRef(forward, up, rh)).toBe(rh);
        expect(writeLookDirectionLHMock).toHaveBeenCalledWith(expect.any(Float32Array), forward, up);
        expect(writeQuatMock).toHaveBeenCalledWith(expect.any(Float32Array), rh);
        expect(rh.asArray()).toEqual([0, 0, 0, 1]);
    });
});
