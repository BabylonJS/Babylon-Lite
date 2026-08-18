import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

type BuiltEnvironmentPatch = {
    _apply(fragment: string, kind: "dds" | "hdr"): string;
};

function readBuiltSkyboxFragment(relativePath: string, variableName: string): string {
    const code = readFileSync(resolve(dirname(LIB_ENTRY), relativePath), "utf8");
    const match = code.match(new RegExp(`const ${variableName} = (".*");`));
    if (!match) {
        throw new Error(`Built skybox shader ${variableName} was not found in ${relativePath}.`);
    }
    return JSON.parse(match[1]!) as string;
}

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
        expect(result.code).not.toContain("scene._environmentRotation");
    });

    it("keeps optional skybox shader code out of a non-feature environment consumer", async () => {
        const result = await runRollup({
            entrySource: `import { loadEnvironment } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(loadEnvironment);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("textureSampleLevel");
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
        expect(result.code).not.toContain("scene._environmentRotation");
    });

    it("retains only the lazy rotation shader patch for setEnvironmentRotation", async () => {
        const result = await runRollup({
            entrySource: `import { setEnvironmentRotation } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(setEnvironmentRotation);\n`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).not.toContain("textureNumLevels");
        expect(result.chunks?.find(({ isEntry }) => isEntry)?.code).not.toContain("cos(scene.envRotationY)");
        expect(result.chunks?.some(({ code, isEntry }) => !isEntry && code.includes("cos(scene.envRotationY)"))).toBe(true);
        expect(result.code).toContain("scene._environmentRotation");
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

    it("applies each patch to the minified shaders shipped in build/lib", async () => {
        const libDir = dirname(LIB_ENTRY);
        const [rotationPatch, blurPatch] = (await Promise.all([
            import(pathToFileURL(resolve(libDir, "material/pbr/fragments/environment-rotation-fragment.js")).href),
            import(pathToFileURL(resolve(libDir, "material/pbr/fragments/environment-blur-fragment.js")).href),
        ])) as [BuiltEnvironmentPatch, BuiltEnvironmentPatch];
        const dds = readBuiltSkyboxFragment("material/pbr/background-dds-skybox.js", "ddsSkyboxFragSrc");
        const hdr = readBuiltSkyboxFragment("material/pbr/background-hdr-skybox.js", "skyboxHdrFragSrc");

        expect(rotationPatch._apply(dds, "dds")).not.toBe(dds);
        expect(rotationPatch._apply(hdr, "hdr")).not.toBe(hdr);
        expect(blurPatch._apply(dds, "dds")).not.toBe(dds);
        expect(blurPatch._apply(hdr, "hdr")).not.toBe(hdr);
        expect(() => rotationPatch._apply("", "dds")).toThrow();
        expect(() => blurPatch._apply("", "dds")).toThrow();
    });
});
