/**
 * Scene 217 — Material Plugin (BlackAndWhite) Parity Test
 *
 * Validates the opt-in `MaterialPlugin` API: a PBR sphere and a Standard box,
 * each with the BlackAndWhite grayscale plugin injected at
 * CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR (Lite slot BC), compared against a Babylon.js
 * golden produced by an equivalent `MaterialPluginBase` plugin.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(217);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene217-material-plugin");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 217 skipped via skipParity in scene-config.json");

test("Scene 217 — Material plugin (BlackAndWhite) matches Babylon.js reference", async ({ page }, testInfo) => {
    await page.goto("/scene217.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
