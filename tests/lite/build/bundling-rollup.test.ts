/**
 * Rollup bundling tests — run the SHIPPED `build/lib` output through Rollup (via Vite's `build()`,
 * which wraps Rollup) in several output modes and assert it bundles with **no errors and no
 * significant warnings**. This is NOT a tree-shaking test: it validates that a downstream
 * Rollup/Vite consumer can build the package cleanly across common configurations (ESM vs CJS
 * output, minified vs not).
 *
 * Rollup is far more permissive than webpack about dynamic requests, so this suite is unlikely to
 * ever catch a "critical dependency"-style issue (that is webpack's job — see `bundling-webpack`).
 * Its value is catching Rollup-surfaced problems: unresolved imports, malformed output for a given
 * format, circular-dependency hazards, or an accidental hard build error. A positive control proves
 * the harness still fails on a genuinely broken bundle.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { barrelEntrySource, cleanupTempDirs, ensureLibBuilt, everyModuleEntrySource, runRollup, SENTINEL } from "./bundler-harness";

beforeAll(() => {
    ensureLibBuilt();
}, 300_000);

afterAll(() => {
    cleanupTempDirs();
});

function expectClean(result: { errors: string[]; significantWarnings: string[] }, context: string): void {
    expect(result.errors, `${context}: Rollup reported errors:\n${result.errors.join("\n")}`).toEqual([]);
    expect(result.significantWarnings, `${context}: Rollup reported warning(s):\n${result.significantWarnings.join("\n")}`).toEqual([]);
}

describe("Rollup bundles @babylonjs/lite build/lib cleanly", () => {
    it("ESM output, unminified (bare barrel import)", async () => {
        const result = await runRollup({ entrySource: barrelEntrySource(), format: "es", minify: false });
        expectClean(result, "esm/unminified");
    }, 180_000);

    it("ESM output, minified (bare barrel import)", async () => {
        const result = await runRollup({ entrySource: barrelEntrySource(), format: "es", minify: true });
        expectClean(result, "esm/minified");
    }, 180_000);

    it("CJS output, unminified (bare barrel import)", async () => {
        const result = await runRollup({ entrySource: barrelEntrySource(), format: "cjs", minify: false });
        expectClean(result, "cjs/unminified");
    }, 180_000);

    it("import EVERY module, ESM output — exercises the whole first-party graph", async () => {
        const result = await runRollup({ entrySource: everyModuleEntrySource(), format: "es", minify: false });
        expectClean(result, "esm/every-module");
    }, 240_000);

    it("positive control: the harness DOES surface a broken bundle (unresolved import)", async () => {
        // Guards against the assertions above passing vacuously. Importing a non-existent module
        // MUST produce a Rollup error.
        const broken = `import ${JSON.stringify("./this-module-does-not-exist.js")};\n${SENTINEL}\n`;
        const result = await runRollup({ entrySource: broken, format: "es", minify: false });
        expect(result.errors.length, `Expected a Rollup error for an unresolved import but saw none.`).toBeGreaterThan(0);
    }, 120_000);
});
