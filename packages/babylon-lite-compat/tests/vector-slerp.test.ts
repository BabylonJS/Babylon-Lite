import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
    slerp: vi.fn((start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }, amount: number, result: { x: number; y: number; z: number }) => {
        result.x = start.x + end.x;
        result.y = start.y + end.y;
        result.z = amount;
        return result;
    }),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    slerpVec3ToRef: hooks.slerp,
}));

import { Vector3 } from "../src/math/vector";

describe("Vector3 spherical interpolation adapters", () => {
    beforeEach(() => {
        hooks.slerp.mockClear();
    });

    it("forwards SlerpToRef arguments to Lite", () => {
        const start = new Vector3(1, 2, 3);
        const end = new Vector3(4, 5, 6);
        const result = new Vector3();

        expect(Vector3.SlerpToRef(start, end, 0.25, result)).toBe(result);
        expect(hooks.slerp).toHaveBeenCalledWith(start, end, 0.25, result);
        expect(result.asArray()).toEqual([5, 7, 0.25]);
    });

    it("translates SmoothToRef timing to the Babylon.js interpolation amount", () => {
        const source = new Vector3(1, 2, 3);
        const goal = new Vector3(4, 5, 6);
        const result = new Vector3();
        const slerp = vi.spyOn(Vector3, "SlerpToRef");

        Vector3.SmoothToRef(source, goal, 2, 8, result);
        expect(slerp).toHaveBeenLastCalledWith(source, goal, 0.25, result);
        expect(hooks.slerp).toHaveBeenLastCalledWith(source, goal, 0.25, result);

        Vector3.SmoothToRef(source, goal, 2, 0, result);
        expect(slerp).toHaveBeenLastCalledWith(source, goal, 1, result);
        expect(hooks.slerp).toHaveBeenLastCalledWith(source, goal, 1, result);
        slerp.mockRestore();
    });
});
