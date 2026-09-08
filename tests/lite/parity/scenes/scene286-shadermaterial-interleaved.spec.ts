import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(286);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene286-shadermaterial-interleaved");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 286 - ShaderMaterial on interleaved glTF matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 286 });

    await page.goto("/scene286.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    // The four-corner gradient is the assertion that matters: it verifies the ShaderMaterial
    // path honours POSITION's non-canonical byteStride (28, not the tight 12) inside the
    // shared interleaved bufferView. COLOR_0 is included in the draw for visual coverage, but
    // the loader always materializes it into its own tight buffer, so this scene does not
    // exercise a non-zero per-attribute *offset* — that is covered by a synthetic-layout unit
    // test (see shader-vb-color-offset.test.ts) since no real loader path currently produces
    // one for the ShaderMaterial pipeline.
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
