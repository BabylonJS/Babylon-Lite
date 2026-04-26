/**
 * Scene 6 — PBR Gold Sphere Parity Test
 *
 * Captures the Babylon Lite PBR procedural sphere and compares against
 * the golden reference (captured from Babylon.js playground #2FDQT5#1505).
 *
 * Assertions:
 * - Full image MAD ≤ 5
 * - ≥80% of pixels within 5 of reference
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(6);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene6-pbr-sphere");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 6 skipped via skipParity in scene-config.json");

test("Scene 6 — PBR Gold Sphere matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 6 });

    await page.goto("/scene6.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(full.within5 / full.totalPixels, "≥80% of pixels within 5 of reference").toBeGreaterThanOrEqual(0.8);
});
