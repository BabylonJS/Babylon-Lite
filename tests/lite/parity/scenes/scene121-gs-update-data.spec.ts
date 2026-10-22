/**
 * Scene 121 — Gaussian Splatting updateData parity test.
 *
 * Loads Halo_Believe.splat with retained splat data, shifts the first
 * 30 000 splats down on Y, calls updateData(), and compares the render
 * against the committed Babylon.js golden reference.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(121);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene121-gs-update-data");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 121 skipped via skipParity in scene-config.json");

test("Scene 121 — Gaussian Splatting updateData matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    await page.goto("/scene121.html");
    await waitForCanvasReady(page, { timeout: 150_000, label: "Lite scene 121" });
    await expect(page.locator("#loader-overlay")).toHaveCount(0, { timeout: 5_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}  within1=${((100 * full.within1) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
