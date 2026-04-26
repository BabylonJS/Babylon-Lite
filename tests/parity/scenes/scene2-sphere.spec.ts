/**
 * Scene 2 — Sphere + DirectionalLight Parity Test
 *
 * Captures the Babylon Lite StandardMaterial sphere render and compares
 * against the golden reference (captured from Babylon.js playground #20OAV9#1).
 *
 * Assertions:
 * - Full image MAD ≤ 1 (near pixel-perfect)
 * - ≥99% of sphere pixels are exact matches
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(2);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene2-sphere");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 2 skipped via skipParity in scene-config.json");

test("Scene 2 — Sphere + DirectionalLight matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 2 });

    await page.goto("/scene2.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    // Compare sphere region (non-background pixels)
    // Scene 2 background: clearColor = (0.2, 0.2, 0.3, 1) = (51, 51, 77)
    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Sphere region (${region.regionPixels} px):`);
    console.log(`  MAD: ${region.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * region.exactMatch) / region.regionPixels).toFixed(1)}%`);
    console.log(`  ≤1: ${((100 * region.within1) / region.regionPixels).toFixed(1)}%`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    // Assertions — scene 2 is near pixel-perfect
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad, `Sphere MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(region.exactMatch / region.regionPixels, "Sphere ≥95% exact match").toBeGreaterThanOrEqual(0.95);
});
