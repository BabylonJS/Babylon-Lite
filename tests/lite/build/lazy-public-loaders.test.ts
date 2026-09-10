import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt);

describe("lazy public loaders", () => {
    it("loads the font-weight implementation without retaining it in the initial chunk", async () => {
        const result = await runRollup({
            entrySource: `import { createTextRenderable, loadFontWeightOffset } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createTextRenderable, loadFontWeightOffset);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        const entry = result.chunks?.find((chunk) => chunk.isEntry);
        const lazyCode = result.chunks
            ?.filter((chunk) => !chunk.isEntry)
            .map((chunk) => chunk.code)
            .join("\n");
        expect(entry?.code).not.toContain("fn wdst(");
        expect(lazyCode).toContain("fn wdst(");
    });
});
