/**
 * Scene 7 — ChibiRex Animated Dinosaur Parity Test
 *
 * Golden reference was captured from BJS with ?seekTime=2 to freeze
 * the skeleton at a deterministic pose. Lite uses the same seekTime.
 *
 * Thresholds: MAD ≤ 1.0 (current ~0.63), ≥99% of pixels within 5 bytes.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(7);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene7-chibirex");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 7 skipped via skipParity in scene-config.json");

test("Scene 7 — ChibiRex Animated matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 7, seekTime: 2, timeout: 120_000 });

    await page.goto("/scene7.html?seekTime=2");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(200);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`ChibiRex region (${region.regionPixels} px):`);
    console.log(`  MAD: ${region.mad.toFixed(2)}`);
    console.log(`  Exact: ${((100 * region.exactMatch) / region.regionPixels).toFixed(1)}%`);
    console.log(`  ≤1: ${((100 * region.within1) / region.regionPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * region.within5) / region.regionPixels).toFixed(1)}%`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(2)}`);

    expect(region.mad, `ChibiRex MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(region.within5 / region.regionPixels, "ChibiRex ≥99% within 5 bytes").toBeGreaterThanOrEqual(0.99);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
