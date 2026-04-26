/**
 * Scene 27 — Material Variants Parity Test
 *
 * Loads a refrigerator glTF with KHR_materials_variants and selects "White" variant.
 * Compares Lite render against golden BJS reference.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(27);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene27-material-variants");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 27 skipped via skipParity in scene-config.json");

test("Scene 27 — Material Variants matches Babylon.js reference", async ({ page }) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 27, timeout: 120_000, settleMs: 3000 });

    await page.goto("/scene27.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
