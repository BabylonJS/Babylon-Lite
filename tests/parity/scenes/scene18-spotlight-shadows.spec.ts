/**
 * Scene 18 — Spotlight Hard Shadows (PCF) Parity Test
 *
 * FreeCamera + SpotLight + PCF shadow generator with ground and box.
 * Compares against golden reference from Babylon.js.
 *
 * Assertions:
 * - Full image MAD ≤ 0.03
 * - ≥99% of pixels within 5 bytes
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(18);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene18-spotlight-shadows");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 18 skipped via skipParity in scene-config.json");

test("Scene 18 — Spotlight Hard Shadows (PCF) matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 18 });

    await page.goto("/scene18.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(1000);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤1: ${((100 * full.within1) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(full.within5 / full.totalPixels, "≥99% within 5 bytes").toBeGreaterThanOrEqual(0.99);
});
