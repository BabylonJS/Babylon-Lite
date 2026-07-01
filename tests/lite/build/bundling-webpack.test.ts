/**
 * Webpack bundling tests — run the SHIPPED `build/lib` output through webpack in several modes and
 * assert it bundles with **no errors and no significant warnings**. This is NOT a tree-shaking test:
 * it validates that a downstream webpack consumer can build the package cleanly however their
 * pipeline is configured.
 *
 * Why this matters (and why the Rollup tests can't replace it): webpack's static analysis flags
 * constructs Rollup/Vite silently accept. The motivating regression was
 * `new URL(<runtime-expr>, import.meta.url)` in `mesh/csg2.js` (CSG2's manifold-3d wasm loader),
 * which makes webpack emit "Critical dependency: the request of a dependency is an expression".
 * That warning is fatal for consumers whose build treats warnings as errors (e.g. webpack +
 * FailOnWarningPlugin, common with Google-Closure-optimized pipelines such as Word Web) — even
 * though CSG2 is never used.
 *
 * The load-bearing detail: with default webpack tree-shaking a bare barrel import drops `csg2.js`
 * before it is parsed, so the warning never appears. This suite therefore includes BOTH a
 * tree-shaking-disabled mode (mimicking a Closure-optimized pipeline) AND an "import every module"
 * mode — either forces `csg2.js` (and every other dynamic-only module) to be parsed, which is where
 * webpack-hostile constructs surface. A positive control proves the harness still detects one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { barrelEntrySource, cleanupTempDirs, ensureLibBuilt, everyModuleEntrySource, runWebpack, SENTINEL } from "./bundler-harness";

beforeAll(() => {
    ensureLibBuilt();
}, 300_000);

afterAll(() => {
    cleanupTempDirs();
});

/** Assert a webpack build produced no errors and no significant (non-size/perf) warnings. */
function expectClean(result: { errors: string[]; significantWarnings: string[] }, context: string): void {
    expect(result.errors, `${context}: webpack reported errors:\n${result.errors.join("\n")}`).toEqual([]);
    expect(
        result.significantWarnings,
        `${context}: webpack reported warning(s) a downstream consumer may treat as fatal:\n${result.significantWarnings.join("\n")}\n\n` +
            "The most likely cause is a webpack-hostile construct in a bundled module — e.g. " +
            "`new URL(<runtime-expr>, import.meta.url)`, `require(<expr>)`, or a bare dynamic `import(<expr>)`. " +
            "Rework it so webpack can statically analyse it (see mesh/csg2.ts for the `import.meta.url` alias pattern)."
    ).toEqual([]);
}

describe("webpack bundles @babylonjs/lite build/lib cleanly", () => {
    it("production, tree-shaking ON (bare barrel import)", async () => {
        const result = await runWebpack({ entrySource: barrelEntrySource(), mode: "production", disableTreeShaking: false });
        expectClean(result, "production + tree-shaking");
    }, 180_000);

    it("production, tree-shaking OFF — mimics a Closure-optimized pipeline (bare barrel import)", async () => {
        // Tree-shaking off forces webpack to parse every barrel-reachable module, including CSG2.
        // This is the mode that reproduced the downstream Word Web failure.
        const result = await runWebpack({ entrySource: barrelEntrySource(), mode: "production", disableTreeShaking: true });
        expectClean(result, "production, tree-shaking disabled");
    }, 240_000);

    it("development mode (bare barrel import)", async () => {
        const result = await runWebpack({ entrySource: barrelEntrySource(), mode: "development", disableTreeShaking: false });
        expectClean(result, "development");
    }, 180_000);

    it("import EVERY module — forces dynamic-only modules (csg2, etc.) to be parsed", async () => {
        // Even with tree-shaking on, statically importing every module means webpack parses each one,
        // so a webpack-hostile construct in a module normally reached only via dynamic import() is caught.
        const result = await runWebpack({ entrySource: everyModuleEntrySource(), mode: "production", disableTreeShaking: false });
        expectClean(result, "import every module");
    }, 240_000);

    it("positive control: the harness DOES surface a webpack-hostile `new URL(<expr>, import.meta.url)`", async () => {
        // Guards against the assertions above passing vacuously due to config drift (e.g. webpack no
        // longer analysing URL dependencies). A dynamic first arg MUST trip the "Critical dependency" warning.
        const hostile = `const p = String(Math.random());\nexport const u = new URL(p, import.meta.url).href;\n${SENTINEL}\n`;
        const result = await runWebpack({ entrySource: hostile, mode: "production", disableTreeShaking: true });
        expect(
            result.significantWarnings.some((w) => /Critical dependency/.test(w)),
            `Expected a "Critical dependency" warning but saw:\n${result.significantWarnings.join("\n") || "(none)"}`
        ).toBe(true);
    }, 120_000);
});
