/**
 * Webpack tree-shaking test — the webpack counterpart of `treeshake-rollup.test.ts`. Both prove the
 * package's `sideEffects: false` claim is honest by bundling a side-effect-only import and asserting
 * the bundler eliminates the entire first-party graph, leaving only a sentinel `console.log`.
 * Anything else surviving is, by definition, module-level code that runs merely on import (a
 * top-level `globalThis` mutation, a `register*()` call, a `new Map()` at module scope, a vendor
 * lib's import-time init, etc.), which defeats tree-shaking.
 *
 * Two sub-tests mirror the Rollup port:
 *   1. Bare barrel import of the built package — the real-world consumer guarantee.
 *   2. Import EVERY built module — forces dynamic-`import()`-only modules (e.g. `mesh/csg2.js`) into
 *      the parsed graph, which the bare-barrel test cannot see because they tree-shake away first.
 *
 * Assertion differs from Rollup's exact-string check only in mechanism: webpack wraps output in an
 * IIFE + runtime scaffold, so we assert the sentinel survived AND no first-party identifier did,
 * rather than byte-equality. Production mode = full webpack tree-shaking + minification.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    barrelEntrySource,
    cleanupTempDirs,
    ensureLibBuilt,
    everyModuleEntrySource,
    isSentinelOnly,
    makeTempEntry,
    runWebpack,
    SENTINEL,
    survivingPackageSubsystems,
} from "./bundler-harness";

beforeAll(() => {
    ensureLibBuilt();
}, 300_000);

afterAll(() => {
    cleanupTempDirs();
});

function expectSentinelOnly(code: string, errors: string[], context: string): void {
    expect(errors, `${context}: webpack reported errors:\n${errors.join("\n")}`).toEqual([]);
    const survivors = survivingPackageSubsystems(code);
    expect(
        isSentinelOnly(code),
        `${context}: importing @babylonjs/lite retained first-party code (${survivors.join(", ") || "sentinel missing"}). ` +
            "Anything beyond the sentinel is a module-level side effect (top-level globalThis mutation, register*() call, " +
            "`new Map()` at module scope, vendor init, etc.). Make it lazy/pure so the package's `sideEffects: false` claim holds."
    ).toBe(true);
}

describe("webpack tree-shakes @babylonjs/lite (no module-level side effects)", () => {
    it("bundles a bare `import` of the built package down to nothing (only the sentinel survives)", async () => {
        const { code, errors } = await runWebpack({ entrySource: barrelEntrySource(), mode: "production", disableTreeShaking: false });
        expectSentinelOnly(code, errors, "bare barrel import");
    }, 180_000);

    it("every built module is side-effect-free, including dynamically-imported ones", async () => {
        const { code, errors } = await runWebpack({ entrySource: everyModuleEntrySource(), mode: "production", disableTreeShaking: false });
        expectSentinelOnly(code, errors, "import every module");
    }, 240_000);

    it("positive control: the harness DOES surface a real module-level side effect", async () => {
        // Guards against the assertions above passing vacuously (config drift). A module that mutates
        // a global on import MUST survive tree-shaking — proving webpack still retains side effects.
        const sideMod = makeTempEntry(`globalThis.__LITE_SIDE_EFFECT_PROBE__ = (globalThis.__LITE_SIDE_EFFECT_PROBE__ ?? 0) + 1;\nexport const noop = () => {};\n`);
        const { code, errors } = await runWebpack({ entrySource: `import ${JSON.stringify(sideMod)};\n${SENTINEL}\n`, mode: "production", disableTreeShaking: false });
        expect(errors).toEqual([]);
        expect(code, "webpack tree-shook away a module-level global mutation — the harness would miss real side effects").toContain("__LITE_SIDE_EFFECT_PROBE__");
    }, 120_000);

    it("positive control: the surviving-identifier detector flags first-party code", () => {
        // Guards the `survivingPackageSubsystems` regexes (used by the assertions above) against drift:
        // if they stopped matching, a genuine leak would pass silently. Pure check, no bundler needed.
        expect(survivingPackageSubsystems("...createEngine(...)...")).toContain("engine");
        expect(survivingPackageSubsystems("...reserveIDs(65536)...")).toContain("csg2/manifold");
        expect(survivingPackageSubsystems('console.log("Babylon Lite bundler harness sentinel");')).toEqual([]);
    });
});
