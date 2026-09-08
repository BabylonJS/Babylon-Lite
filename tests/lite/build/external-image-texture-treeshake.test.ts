import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt);

describe("external-image texture tree shaking", () => {
    it("keeps the external-image factory out of consumers that do not import it", async () => {
        const result = await runRollup({
            entrySource: `import { createSceneContext } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createSceneContext);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).not.toContain("createTexture2DFromExternalImage");
        expect(result.code).not.toContain("source has no supported positive intrinsic dimensions");
    });

    it("retains the factory when explicitly imported", async () => {
        const result = await runRollup({
            entrySource: `import { createTexture2DFromExternalImage } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createTexture2DFromExternalImage);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("createTexture2DFromExternalImage");
        expect(result.code).toContain("source has no supported positive intrinsic dimensions");
    });
});
