import { describe, expect, it } from "vitest";
import { buildStrokePoints } from "../src/rendering/stroke-geometry.js";

describe("stroke caps", () => {
    it("does not extend open paths with butt caps", () => {
        const vertices: number[] = [];

        const count = buildStrokePoints([0, 0, 100, 0], 2, 10, false, vertices, 1);

        expect(count).toBe(6);
        const xs = vertices.filter((_, index) => index % 2 === 0);
        expect(Math.min(...xs)).toBe(0);
        expect(Math.max(...xs)).toBe(100);
    });

    it.each([
        [0, 0, 0, 0, 100, 0],
        [0, 0, 100, 0, 100, 0],
    ])("keeps duplicate endpoint clusters square", (...poly) => {
        const vertices: number[] = [];

        buildStrokePoints(poly, 3, 10, false, vertices, 1);

        const xs = vertices.filter((_, index) => index % 2 === 0);
        expect(Math.min(...xs)).toBe(0);
        expect(Math.max(...xs)).toBe(100);
    });

    it("retains round caps by default", () => {
        const vertices: number[] = [];

        const count = buildStrokePoints([0, 0, 100, 0], 2, 10, false, vertices);

        expect(count).toBeGreaterThan(6);
        const xs = vertices.filter((_, index) => index % 2 === 0);
        expect(Math.min(...xs)).toBe(-10);
        expect(Math.max(...xs)).toBe(110);
    });

    it("retains the round fallback for unsupported square caps", () => {
        const vertices: number[] = [];

        buildStrokePoints([0, 0, 100, 0], 2, 10, false, vertices, 3);

        const xs = vertices.filter((_, index) => index % 2 === 0);
        expect(Math.min(...xs)).toBe(-10);
        expect(Math.max(...xs)).toBe(110);
    });

    it("treats every closed-path vertex as a join regardless of cap style", () => {
        const vertices: number[] = [];

        const count = buildStrokePoints([0, 0, 100, 0, 100, 100], 3, 10, true, vertices, 1);

        expect(count).toBeGreaterThan(18);
    });
});
