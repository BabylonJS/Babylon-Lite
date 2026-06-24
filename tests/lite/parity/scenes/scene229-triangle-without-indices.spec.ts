/**
 * Scene 229 — Triangle Without Indices Parity Test
 *
 * The glTF primitive intentionally omits `indices`. Lite should synthesize an
 * identity index buffer at load time and keep the indexed GPU draw path.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(229);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene229-triangle-without-indices");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 229 skipped via skipParity in scene-config.json");

test("Scene 229 — non-indexed glTF triangle matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 229 });

    await page.goto("scene229.html");
    await waitForCanvasReady(page, { timeout: 60_000, label: "Scene 229 Lite" });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF, [51, 51, 77], 10);
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Triangle region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}, within-5=${((100 * region.within5) / region.regionPixels).toFixed(1)}%`);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(region.regionPixels, "The reference triangle should occupy a visible region").toBeGreaterThan(1000);
    expect(region.mad, `Triangle region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
