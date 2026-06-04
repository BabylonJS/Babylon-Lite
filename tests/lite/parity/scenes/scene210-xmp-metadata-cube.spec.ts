import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(210);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene210-xmp-metadata-cube");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 210 skipped via skipParity in scene-config.json");

test("Scene 210 — glTF KHR_xmp_json_ld matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 210 });

    await page.goto("/scene210.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(1000);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
