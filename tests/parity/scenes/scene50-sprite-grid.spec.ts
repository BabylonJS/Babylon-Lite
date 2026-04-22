/**
 * Scene 50 — Sprite Grid Parity Test
 *
 * Compares Babylon Lite's sprite renderer rendering of a 25×10 sprite grid
 * against the Babylon.js SpriteManager rendering of the same grid (oracle).
 * Golden is captured automatically from the BJS reference page on first run
 * (or when RECAPTURE_GOLDEN=1 is set).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(50);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene50-sprite-grid");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 50 skipped via skipParity in scene-config.json");

test("Scene 50 — Sprite Grid matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 50 });

    // Force MSAA 4 to match BJS oracle's default; lab demo defaults to MSAA 1 for perf.
    await page.goto("/scene50.html?msaa=4");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
