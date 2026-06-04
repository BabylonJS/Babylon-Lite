/**
 * Scene 200 — High-Precision Matrix Jitter (HPM **off**, FO **off**) Parity Test
 *
 * Renders the shared HPM-jitter scene with default precision (Lite:
 * `useHighPrecisionMatrix: false`, `useFloatingOrigin: false`) and
 * compares against the BJS reference (also default precision). Both
 * stacks should jitter similarly at world ~5e6.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(200);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene200-high-precision-jitter-hpm-off");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 200 skipped via skipParity in scene-config.json");

test("Scene 200 — HPM Jitter (HPM off) matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 200 });

    await page.goto("/scene200.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 200 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
