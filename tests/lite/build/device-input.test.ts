import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt, 300_000);

describe("standalone device input isolation", () => {
    it("adds no runtime code when all input exports are unused", async () => {
        const source = `import { createSceneContext } from ${JSON.stringify(LIB_ENTRY)}; console.log(createSceneContext);`;
        const baseline = await runRollup({ entrySource: source, format: "es", minify: false });
        const withInputs = source.replace("createSceneContext }", "createSceneContext, createKeyboardInput, createPointerInput, readGamepad }");
        const result = await runRollup({ entrySource: withInputs, format: "es", minify: false });
        expect(baseline.errors).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toBe(baseline.code);
    });

    it.each([
        ["createKeyboardInput", "keydown", ["pointermove", "getGamepads"]],
        ["createPointerInput", "pointermove", ["keydown", "getGamepads"]],
        ["readGamepad", "getGamepads", ["keydown", "pointermove"]],
    ] as const)("retains only the consumed %s device family", async (name, retained, excluded) => {
        const result = await runRollup({ entrySource: `export { ${name} } from ${JSON.stringify(LIB_ENTRY)};`, format: "es", minify: false });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain(retained);
        for (const value of excluded) {
            expect(result.code).not.toContain(value);
        }
        expect(result.code).not.toContain("createSceneContext");
        expect(result.code).not.toContain("GPUBufferUsage");
    });
});
