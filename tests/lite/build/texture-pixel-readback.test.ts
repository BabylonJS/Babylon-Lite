import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

afterAll(cleanupTempDirs);
beforeAll(ensureLibBuilt);

describe("texture pixel readback tree shaking", () => {
    it("eliminates conversion and staging from existing texture consumers", async () => {
        const result = await runRollup({
            entrySource: `import { createTexture2DFromPixels, loadCubeTexture } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(createTexture2DFromPixels, loadCubeTexture);`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).not.toContain("readTexturePixelsRGBA8");
        expect(result.code).not.toContain("texture-preview");
        expect(result.code).not.toContain("texture-pixels-readback");
    });

    it("eliminates GPU conversion when only metadata is imported", async () => {
        const result = await runRollup({
            entrySource: `import { getTextureReadbackInfo } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(getTextureReadbackInfo);`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("getTextureReadbackInfo");
        expect(result.code).not.toContain("texture-preview");
        expect(result.code).not.toContain("createRenderPipeline");
        expect(result.code).not.toContain("texture-pixels-readback");
    });

    it("retains readback only on explicit import, without texture factories or material code", async () => {
        const result = await runRollup({
            entrySource: `import { readTexturePixelsRGBA8 } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(readTexturePixelsRGBA8);`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("readTexturePixelsRGBA8");
        expect(result.code).toContain("texture-pixels-readback");
        expect(result.code).not.toContain("loadCubeTexture");
        expect(result.code).not.toContain("createTexture2DFromPixels");
        expect(result.code).not.toContain("createStandardMaterial");
    });
});
