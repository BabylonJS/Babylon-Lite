import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);
afterAll(cleanupTempDirs);

describe("inverseLerp root export isolation", () => {
    it("runs the root arithmetic helper without retaining renderer code", async () => {
        // Omit the harness's external vendor/worker imports while retaining every first-party initialization.
        const result = await runRollup({ entrySource: `export { inverseLerp } from ${JSON.stringify(LIB_ENTRY)};`, format: "es", minify: false, forceModuleSideEffects: true });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).not.toMatch(/GPU|createEngine|createRenderTask/);
        const module = (await import(`data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`)) as {
            inverseLerp: (a: number, b: number, value: number) => number;
        };
        expect(module.inverseLerp(10, 20, 25)).toBe(1);
    });

    it("emits identical vector interpolation code when inverseLerp is imported but unused", async () => {
        const source = `export { lerpVec3 } from ${JSON.stringify(LIB_ENTRY)};`;
        const baseline = await runRollup({ entrySource: source, format: "es", minify: false });
        const unused = await runRollup({ entrySource: `import { inverseLerp } from ${JSON.stringify(LIB_ENTRY)}; ${source}`, format: "es", minify: false });
        expect(baseline.errors).toEqual([]);
        expect(unused.errors).toEqual([]);
        expect(unused.code).toBe(baseline.code);
    });
});
