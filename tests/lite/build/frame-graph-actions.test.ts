import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt, 300_000);

describe("frame-graph action isolation", () => {
    it("exposes task removal from the root without retaining rendering implementations", async () => {
        const result = await runRollup({
            entrySource: `export { removeTask } from ${JSON.stringify(LIB_ENTRY)};\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("function removeTask");
        expect(result.code).not.toContain("createRenderPass");
        expect(result.code).not.toContain("createFrameGraph");
        expect(result.code).not.toContain("createEngine");
    });

    it("strips removal when only insertion is imported", async () => {
        const result = await runRollup({
            entrySource: `export { addTask } from ${JSON.stringify(LIB_ENTRY)};\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("function addTask");
        expect(result.code).not.toContain("removeTask");
    });
});
