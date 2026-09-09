import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt);

describe("world-to-screen tree shaking", () => {
    it("retains zero projection bytes when unused", async () => {
        const baseline = await runRollup({
            entrySource: `import { createSceneContext } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createSceneContext);\n`,
            format: "es",
            minify: false,
        });
        const result = await runRollup({
            entrySource: `import { createSceneContext, projectWorldToScreen, projectWorldToScreenToRef } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createSceneContext);\n`,
            format: "es",
            minify: false,
        });

        expect(baseline.errors).toEqual([]);
        expect(baseline.significantWarnings).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toBe(baseline.code);
        expect(result.code).not.toContain("ScreenProjectionOptions");
        expect(result.code).not.toContain("behindCamera");
    });

    it("retains the projection module when its public helper is consumed", async () => {
        const result = await runRollup({
            entrySource: `import { projectWorldToScreenToRef } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(projectWorldToScreenToRef);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("ScreenProjectionOptions");
        expect(result.code).toContain("behindCamera");
    });
});
