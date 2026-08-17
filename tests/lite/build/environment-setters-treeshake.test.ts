import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt);

describe("environment setter tree shaking", () => {
    it("keeps rotation UBO update logic out of a non-environment scene consumer", async () => {
        const result = await runRollup({
            entrySource: `import { createSceneContext } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createSceneContext);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).not.toContain("scene.envRotationY");
    });

    it("keeps blur and rotation shader code out of a non-feature environment consumer", async () => {
        const result = await runRollup({
            entrySource: `import { loadEnvironment } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(loadEnvironment);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("/*ENV_DIRECTION*/");
        expect(result.code).toContain("/*ENV_LOD*/");
        expect(result.code).not.toContain("textureNumLevels");
        expect(result.code).not.toContain("cos(scene.envRotationY)");
    });

    it("retains only the blur shader patch for setEnvironmentBlur", async () => {
        const result = await runRollup({
            entrySource: `import { setEnvironmentBlur } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(setEnvironmentBlur);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("textureNumLevels");
        expect(result.code).not.toContain("cos(scene.envRotationY)");
        expect(result.code).not.toContain("scene.envRotationY");
    });

    it("retains only the rotation shader patch for setEnvironmentRotation", async () => {
        const result = await runRollup({
            entrySource: `import { setEnvironmentRotation } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(setEnvironmentRotation);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).not.toContain("textureNumLevels");
        expect(result.code).toContain("cos(scene.envRotationY)");
        expect(result.code).toContain("scene.envRotationY");
    });

    it("retains both patches when both setters are consumed", async () => {
        const result = await runRollup({
            entrySource: `import { loadEnvironment, setEnvironmentBlur, setEnvironmentRotation } from ${JSON.stringify(
                LIB_ENTRY
            )};\nconsole.log(loadEnvironment, setEnvironmentBlur, setEnvironmentRotation);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("textureNumLevels");
        expect(result.code).toContain("cos(scene.envRotationY)");
    });
});
