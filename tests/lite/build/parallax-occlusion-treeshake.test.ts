import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness.js";

beforeAll(ensureLibBuilt, 300_000);
afterAll(cleanupTempDirs);

describe("parallax occlusion opt-in boundaries", () => {
    it.each([
        ["createPbrMaterial", false, false],
        ["createStandardMaterial", false, false],
        ["getMaterialTextures", false, false],
        ["createPbrMaterial, setPbrParallaxOcclusion", true, false],
        ["createStandardMaterial, setStandardParallaxOcclusion", false, true],
    ] as const)("retains only the requested material extension for %s", async (imports, pbr, standard) => {
        const result = await runRollup({
            entrySource: `import { ${imports} } from ${JSON.stringify(LIB_ENTRY)}; console.log(${imports});`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code.includes("fn parallaxOffset(")).toBe(pbr || standard);
        expect(result.code.includes("pbrParallaxOcclusionExt")).toBe(pbr);
        expect(result.code.includes("stdParallaxOcclusionExt")).toBe(standard);
    });
});
