import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);
afterAll(cleanupTempDirs);

const markers = ["meshOpacityUniforms", "0-mesh-opacity", "z-mesh-opacity", "opacity must be a finite number"];

describe("native mesh-opacity opt-in boundary", () => {
    it.each(["createStandardMaterial", "createPbrMaterial"])("keeps opacity semantics out of %s without opt-in", async (factory) => {
        const result = await runRollup({
            entrySource: `export { ${factory}, createSceneContext, registerScene } from ${JSON.stringify(LIB_ENTRY)};`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        for (const marker of markers) {
            expect(result.code).not.toContain(marker);
        }
    });

    it.each(["createStandardMaterial", "createPbrMaterial"])("retains real opacity implementation when used with %s", async (factory) => {
        const result = await runRollup({
            entrySource: `export { ${factory}, createSceneContext, registerScene, setMeshOpacity, getMeshOpacity } from ${JSON.stringify(LIB_ENTRY)};`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        for (const marker of markers) {
            expect(result.code).toContain(marker);
        }
    });

    it.each(["createStandardMaterial", "createPbrMaterial"])("emits byte-identical %s code with opacity imported but unused", async (factory) => {
        const source = `export { ${factory}, createSceneContext, registerScene } from ${JSON.stringify(LIB_ENTRY)};`;
        const baseline = await runRollup({ entrySource: source, format: "es", minify: false });
        const unused = await runRollup({
            entrySource: `import { setMeshOpacity, getMeshOpacity } from ${JSON.stringify(LIB_ENTRY)}; ${source}`,
            format: "es",
            minify: false,
        });
        expect(baseline.errors).toEqual([]);
        expect(unused.errors).toEqual([]);
        expect(baseline.significantWarnings).toEqual([]);
        expect(unused.significantWarnings).toEqual([]);
        expect(unused.code).toBe(baseline.code);
    });
});
