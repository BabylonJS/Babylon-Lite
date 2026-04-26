/**
 * Scene 26 — PBR Subsurface / Translucency Parity Test
 *
 * Georgia Tech Dragon with translucent teal PBR material, thickness map,
 * point light orbiting, DDS environment. Uses seekTime=3 to freeze orbit.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(26);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene26-pbr-subsurface");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 26 skipped via skipParity in scene-config.json");

test("Scene 26 — PBR Subsurface matches Babylon.js reference", async ({ page }) => {
    test.setTimeout(90_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 26, seekTime: 3, timeout: 90_000 });

    await page.goto("/scene26.html?seekTime=3");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 10_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
