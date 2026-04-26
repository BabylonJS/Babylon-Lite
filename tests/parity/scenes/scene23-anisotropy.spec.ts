/**
 * Scene 23 — PBR Anisotropy Parity Test
 *
 * Metallic sphere (metallic=1, roughness=0) with anisotropic reflections.
 * Uses seekTime=3 to freeze at intensity≈0.39 (moderate anisotropy).
 * seekTime=0 gives intensity=1.0 which makes the bent normal hyper-sensitive
 * to cotangent frame precision, amplifying sub-pixel dpdx/dpdy differences.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(23);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene23-anisotropy");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 23 skipped via skipParity in scene-config.json");

test("Scene 23 — PBR Anisotropy matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(60_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 23, seekTime: 0, timeout: 60_000 });

    await page.goto("/scene23.html?seekTime=0");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 10_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
