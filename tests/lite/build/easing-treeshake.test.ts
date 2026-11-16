import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt, 300_000);

describe("native easing tree shaking", () => {
    it("retains one imported fixed curve without the other easing algorithms", async () => {
        const result = await runRollup({
            entrySource: `export { quadraticEase } from ${JSON.stringify(LIB_ENTRY)};\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("quadraticEase");
        expect(result.code).not.toContain("circleEase");
        expect(result.code).not.toContain("elasticEase");
        expect(result.code).not.toContain("bounceEase");
        expect(result.code).not.toContain("bezierCurveEase");
    });

    it("retains Power and Bezier factories without unrelated curves", async () => {
        const result = await runRollup({
            entrySource: `export { createPowerEase, createBezierCurveEase } from ${JSON.stringify(LIB_ENTRY)};\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("createPowerEase");
        expect(result.code).toContain("powerEase");
        expect(result.code).toContain("createBezierCurveEase");
        expect(result.code).toContain("bezierCurveEase");
        expect(result.code).not.toContain("circleEase");
        expect(result.code).not.toContain("elasticEase");
        expect(result.code).not.toContain("bounceEase");
    });
});
