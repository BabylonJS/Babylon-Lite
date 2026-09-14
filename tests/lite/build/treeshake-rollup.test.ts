/**
 * Module-level side-effect regression tests against the shipped `build/lib` tree.
 *
 * Vite 8 uses Rolldown internally, so these tests invoke Rollup directly: they verify
 * both the package's downstream Rollup compatibility and its `sideEffects: false`
 * promise without trusting package metadata. `forceModuleSideEffects` makes Rollup keep
 * every statement it cannot prove pure, while external vendor/worker modules remain out
 * of scope.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, enumerateLibModules, everyModuleEntrySource, LIB_ENTRY, makeTempEntry, runRollup, SENTINEL } from "./bundler-harness";

const SIDE_EFFECT_SENTINEL = 'console.log("Babylon Lite has no module-level side effects");';
const normalize = (value: string): string => value.replace(/\r\n/g, "\n").trim();

async function bundleEntry(entrySource: string): Promise<string> {
    const result = await runRollup({
        entrySource,
        format: "es",
        minify: false,
        forceModuleSideEffects: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.significantWarnings).toEqual([]);
    return normalize(result.code);
}

beforeAll(ensureLibBuilt);
afterAll(cleanupTempDirs);

describe("@babylonjs/lite has no module-level side effects", () => {
    it("bundles a bare `import` of the built package down to nothing (only the sentinel survives)", async () => {
        const code = await bundleEntry(`import ${JSON.stringify(LIB_ENTRY)};\n${SIDE_EFFECT_SENTINEL}\n`);
        expect(
            code,
            "Importing @babylonjs/lite executed module-level code. Anything below the sentinel is a side effect " +
                "(top-level globalThis mutation, register*() call, `new Map()` at module scope, vendor init, etc.). " +
                "Make it lazy/pure so the package's `sideEffects: false` claim holds.\n\n" +
                code
        ).toBe(normalize(SIDE_EFFECT_SENTINEL));
    }, 120_000);

    it("every built module is side-effect-free, including dynamically-imported ones", async () => {
        const modules = enumerateLibModules();
        const code = await bundleEntry(everyModuleEntrySource());
        expect(
            code,
            `One of the ${modules.length} built modules has a module-level side effect. Anything below the sentinel ` +
                "is code that runs merely on importing that module (top-level globalThis/self mutation, register*() " +
                "call, `new Map()`/`new Set()` at module scope, etc.). Make it lazy (nullable module var + getter) or " +
                "pure (`/* @__PURE__ */` on a pure call).\n\n" +
                code
        ).toBe(normalize(SENTINEL));
    }, 180_000);

    it("drops arc-rotate pointer mapping controls when only camera data is used", async () => {
        const code = await bundleEntry(`import { createArcRotateCamera } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createArcRotateCamera);\n`);
        expect(code).toContain("createArcRotateCamera");
        expect(code).not.toContain("pointerMappings");
        expect(code).not.toContain("gesturestart");
    }, 120_000);

    it("drops arc-rotate keyboard behavior from pointer-only controls", async () => {
        const code = await bundleEntry(`import { attachControl } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(attachControl);\n`);
        expect(code).toContain("pointerdown");
        expect(code).not.toContain("ArrowLeft");
        expect(code).not.toContain("keydown");
        expect(code).not.toContain("zoomingSensitivity");
    }, 120_000);

    it("retains arc-rotate keyboard behavior only after the enabler is requested", async () => {
        const code = await bundleEntry(
            `import { attachControl, enableArcRotateKeyboardControls } from ${JSON.stringify(LIB_ENTRY)};\nenableArcRotateKeyboardControls();\nconsole.log(attachControl);\n`
        );
        expect(code).toContain("ArrowLeft");
        expect(code).toContain("keydown");
        expect(code).toContain("zoomingSensitivity");
    }, 120_000);

    it("positive control: the harness DOES surface a real module-level side effect", async () => {
        const sideEffectModule = makeTempEntry(`globalThis.__LITE_SIDE_EFFECT_PROBE__ = (globalThis.__LITE_SIDE_EFFECT_PROBE__ ?? 0) + 1;\nexport const noop = () => {};\n`);
        const code = await bundleEntry(`import ${JSON.stringify(sideEffectModule)};\n${SIDE_EFFECT_SENTINEL}\n`);
        expect(code).toContain("__LITE_SIDE_EFFECT_PROBE__");
        expect(code).not.toBe(normalize(SIDE_EFFECT_SENTINEL));
    }, 120_000);
});
