/**
 * Scene 1 — BoomBox PBR Parity Test
 *
 * Captures the Babylon Lite BoomBox render and compares against
 * the golden reference (captured from Babylon.js playground #QCU8DJ#800).
 *
 * Assertions:
 * - BoomBox region: MAD ≤ 0.1, ≥99% of pixels within 1 byte
 * - Full image: MAD ≤ 0.5
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(1);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene1-boombox");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 1 skipped via skipParity in scene-config.json");

test("Scene 1 — BoomBox PBR matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 1 });

    // Navigate to our renderer
    await page.goto("/scene1.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    // Extra frame to ensure GPU has flushed
    await page.waitForTimeout(500);

    // Capture our render
    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    // Compare BoomBox region (non-background pixels)
    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`BoomBox region (${region.regionPixels} px):`);
    console.log(`  MAD: ${region.mad.toFixed(2)}`);
    console.log(`  Exact: ${((100 * region.exactMatch) / region.regionPixels).toFixed(1)}%`);
    console.log(`  ≤1: ${((100 * region.within1) / region.regionPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * region.within5) / region.regionPixels).toFixed(1)}%`);

    // Compare full image
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(2)}`);

    // Assertions
    expect(region.mad, `BoomBox MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(region.within1 / region.regionPixels, "BoomBox ≥99% within 1 byte").toBeGreaterThanOrEqual(0.99);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
