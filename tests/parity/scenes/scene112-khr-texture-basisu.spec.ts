/**
 * Scene 112 — KHR_texture_basisu Flight Helmet Parity Test
 *
 * Loads the FlightHelmetKTX glTF asset from BabylonJS/Assets and validates
 * KHR_texture_basisu plus frame-graph transmission against Babylon.js.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(112);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene112-khr-texture-basisu");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 112 — KHR_texture_basisu Flight Helmet matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 112, timeout: 180_000, settleMs: 2_000 });

    await page.goto("/scene112.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 180_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
