/**
 * Scene 252 — StandardMaterial Morph Target Parity Test
 *
 * Renders the Babylon Lite StandardMaterial sphere deformed into a teardrop by a
 * single position morph target, and compares against a golden reference captured
 * from the equivalent Babylon.js scene (StandardMaterial + MorphTargetManager).
 *
 * Validates that StandardMaterial honors morph targets in Lite.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(252);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene252-standard-material-morph");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 252 skipped via skipParity in scene-config.json");

test("Scene 252 — StandardMaterial morph target matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 252 });

    await page.goto("/scene252.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    // Compare the morphed sphere region (non-background pixels).
    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Morphed region (${region.regionPixels} px):`);
    console.log(`  MAD: ${region.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * region.exactMatch) / region.regionPixels).toFixed(1)}%`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad, `Morphed region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(region.exactMatch / region.regionPixels, "Morphed region ≥95% exact match").toBeGreaterThanOrEqual(0.95);
});
