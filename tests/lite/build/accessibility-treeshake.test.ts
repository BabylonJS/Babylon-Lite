import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureLibBuilt, LIB_ENTRY, PACKAGE_DIR, runRollup } from "./bundler-harness";

const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");

function ensureAccessibilityArtifacts(): void {
    const dist = spawnSync(process.execPath, [VITE_JS, "build", "--mode", "dist"], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
    if (dist.status !== 0) {
        throw new Error(`babylon-lite build (--mode dist) failed:\n${dist.stdout ?? ""}${dist.stderr ?? ""}`);
    }
    ensureLibBuilt();
}

beforeAll(ensureAccessibilityArtifacts, 300_000);

describe("passive accessibility package boundary", () => {
    it("removes unused accessibility imports without changing the bundle", async () => {
        const baseline = await runRollup({
            entrySource: `import { createSceneContext } from ${JSON.stringify(LIB_ENTRY)}; console.log(createSceneContext);`,
            format: "es",
            minify: false,
        });
        const withUnusedAccessibility = await runRollup({
            entrySource: `import { createSceneContext, createSceneHtmlTwin, setAccessibilityTag } from ${JSON.stringify(LIB_ENTRY)};
console.log(createSceneContext);`,
            format: "es",
            minify: false,
        });

        expect(baseline.errors).toEqual([]);
        expect(withUnusedAccessibility.errors).toEqual([]);
        expect(withUnusedAccessibility.code).toBe(baseline.code);
    });

    it("retains the passive DOM only when requested", async () => {
        const result = await runRollup({
            entrySource: `import { createSceneHtmlTwin } from ${JSON.stringify(LIB_ENTRY)}; console.log(createSceneHtmlTwin);`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("data-lite-accessibility-node");
        expect(result.code).not.toContain("addEventListener");
        expect(result.code).not.toContain("tabIndex");
    });

    it("exports the passive contract and omits retired interaction APIs", () => {
        const declarations = readFileSync(resolve(PACKAGE_DIR, "build/index.d.ts"), "utf-8");
        for (const name of ["AccessibilityTag", "createSceneAccessibility", "setAccessibilityTag", "createSceneHtmlTwin", "createHtmlTwin"]) {
            expect(declarations).toMatch(new RegExp(`\\b${name}\\b`));
        }
        expect(declarations).toMatch(/createSceneHtmlTwin\(scene: SceneContext, options\?: SceneHtmlTwinOptions\)/);
        expect(declarations).toMatch(/parent\?: HTMLElement/);
        for (const name of [
            "eventHandler",
            "tabIndex",
            "focusHtmlTwinNode",
            "blurHtmlTwin",
            "showSceneFocusIndicator",
            "createNativeControl",
            "createHtmlOverlay",
            "bindAnimationManagerToScene",
            "setSceneAnimationsEnabled",
        ]) {
            expect(declarations).not.toMatch(new RegExp(`\\b${name}\\b`));
        }
    });
});
