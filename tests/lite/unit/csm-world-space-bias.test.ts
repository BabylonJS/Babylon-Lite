import { describe, expect, it } from "vitest";

import { csmWorldBiasClipOffset } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";

describe("CSM world-space caster bias", () => {
    it("keeps the same physical offset across changing fitted cascade depth ranges", () => {
        const worldBias = 0.12;
        const shortRange = csmWorldBiasClipOffset(worldBias, -10, 50);
        const tallRange = csmWorldBiasClipOffset(worldBias, -40, 140);

        expect(shortRange * 60).toBeCloseTo(worldBias, 8);
        expect(tallRange * 180).toBeCloseTo(worldBias, 8);
        expect(shortRange).not.toBe(tallRange);
    });

    it("returns zero for invalid or collapsed ranges", () => {
        expect(csmWorldBiasClipOffset(0.1, 3, 3)).toBe(0);
        expect(csmWorldBiasClipOffset(Number.NaN, 0, 10)).toBe(0);
        expect(csmWorldBiasClipOffset(Number.POSITIVE_INFINITY, 0, 10)).toBe(0);
        expect(csmWorldBiasClipOffset(-0.1, 0, 10)).toBe(0);
    });

    it("preserves the authored distance for every positive finite range", () => {
        const worldBias = 1e-9;
        const range = 1e-7;
        expect(csmWorldBiasClipOffset(worldBias, 0, range) * range).toBeCloseTo(worldBias, 15);
    });

    it("keeps a far-bound caster inside clip space when the projection reserves bias headroom", () => {
        const near = -10;
        const fittedFar = 50;
        const worldBias = 0.12;
        const paddedFar = fittedFar + worldBias;
        const range = paddedFar - near;
        const farCasterDepth = (fittedFar - near) / range + csmWorldBiasClipOffset(worldBias, near, paddedFar);

        expect(farCasterDepth).toBeCloseTo(1, 12);
    });
});
