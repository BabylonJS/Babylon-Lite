import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

/** A statement that exists only in the weight shader fragment (the opt-in feature's WGSL). */
const WEIGHT_ONLY_WGSL = "fn wdst(";
/** A statement that exists only in the shared Slug template (every text consumer needs it). */
const BASE_SLUG_WGSL = "fn rcode(";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt);

describe("text shader fragment tree shaking", () => {
    it("keeps the weight shader fragment out of a text consumer that never imports the setter", async () => {
        const result = await runRollup({
            entrySource: `import { createTextRenderable } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createTextRenderable);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        // The shared Slug template is retained (text still renders) …
        expect(result.code).toContain(BASE_SLUG_WGSL);
        // … but none of the opt-in feature's incremental WGSL is.
        expect(result.code).not.toContain(WEIGHT_ONLY_WGSL);
        expect(result.code).not.toContain("fn dq(");
        expect(result.code).not.toContain("@location(4) @interpolate(flat) wo:f32,");
        expect(result.code).not.toContain("if(in.wo!=0.0){");
    });

    it("retains the weight shader fragment for a text consumer that imports setFontWeightOffset", async () => {
        const result = await runRollup({
            entrySource: `import { createTextRenderable, setFontWeightOffset } from ${JSON.stringify(LIB_ENTRY)};\n` + `console.log(createTextRenderable, setFontWeightOffset);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain(WEIGHT_ONLY_WGSL);
        expect(result.code).toContain("fn dq(");
        // Composition, not duplication: the base Slug logic is still declared exactly once.
        expect(result.code.split(BASE_SLUG_WGSL).length - 1).toBe(1);
    });
});
