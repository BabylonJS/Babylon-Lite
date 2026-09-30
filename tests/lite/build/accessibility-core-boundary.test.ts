import { describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

describe("accessibility core boundary", () => {
    it("removes the accessibility lifecycle bridge when the feature is unused", async () => {
        ensureLibBuilt();
        const result = await runRollup({
            entrySource: `import { addToScene, createSceneContext, disposeScene, removeFromScene } from ${JSON.stringify(LIB_ENTRY)};
console.log(addToScene, createSceneContext, disposeScene, removeFromScene);`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).not.toContain("_sceneAccessibilityHook");
        expect(result.code).not.toContain("_accessibility");
        expect(result.code).not.toContain("nodeChanged");
        cleanupTempDirs();
    });
});
