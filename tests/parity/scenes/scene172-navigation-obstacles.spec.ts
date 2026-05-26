/**
 * Scene 172 — Navigation Obstacles Parity Test
 *
 * Golden reference is captured from the BJS page with ?freeze=1 so the BJS
 * crowd simulation (which runs every frame via onBeforeAnimationsObservable)
 * stays at frame-1 positions. Lite uses the same ?freeze=1 flag to skip
 * its own updateNavCrowd loop.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(172);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene172-navigation-obstacles");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 172 skipped via skipParity in scene-config.json");

test("Scene 172 — Navigation Obstacles matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 172, queryParams: "freeze=1", timeout: 180_000 });

    await page.goto(`/scene172.html?freeze=1`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
