/**
 * Scene 216 — PBR Fog Parity Test
 *
 * A receding row of 10 gold PBR boxes fades into linear fog whose colour matches
 * the background. Validates that PBR materials apply fog identically to Babylon.js:
 * the fog is mixed into the linear HDR colour before the tonemap/image-processing
 * chain, using the PBR-specific linearised fog factor (toLinearSpace(fog)).
 *
 * Assertions:
 * - Full image MAD ≤ scene-config maxMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(216);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene216-pbr-fog");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 216 skipped via skipParity in scene-config.json");

test("Scene 216 — PBR fog matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 216, force: true });

    await page.goto("scene216.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
