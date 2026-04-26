/**
 * Scene 5 — Alien PBR + Skeleton Animation Parity Test
 *
 * Both the golden reference and Babylon Lite seek to exactly 0.5 s of
 * animation time (via ?seekTime=0.5) so the skeleton pose is identical.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(5);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene5-alien");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 5 skipped via skipParity in scene-config.json");

test("Scene 5 — Alien PBR + Skeleton Animation matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 5, seekTime: 2 });

    await page.goto("/scene5.html?seekTime=2");

    // Wait for canvas ready, then wait for exact frame 300 freeze signal
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    // GPU queue flush — animation is already frozen so no extra frames advance
    await page.waitForTimeout(200);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    // Compare alien region (non-background pixels)
    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Alien region (${region.regionPixels} px):`);
    console.log(`  MAD: ${region.mad.toFixed(2)}`);
    console.log(`  Exact: ${((100 * region.exactMatch) / region.regionPixels).toFixed(1)}%`);
    console.log(`  ≤1: ${((100 * region.within1) / region.regionPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * region.within5) / region.regionPixels).toFixed(1)}%`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(2)}`);

    expect(region.mad, `Alien MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(region.within5 / region.regionPixels, "Alien ≥75% within 5 bytes").toBeGreaterThanOrEqual(0.75);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
