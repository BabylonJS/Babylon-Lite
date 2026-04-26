/**
 * Scene 12 — PBR Shader Balls Parity Test
 *
 * Loads shaderBall_rotation.glb with metallic reflectance textures,
 * directional light, and environment rotation. Golden reference was
 * captured from BJS with ?seekTime=0.5 to freeze the animation.
 * Lite uses the same seekTime.
 *
 * Assertions:
 * - Full image MAD ≤ 0.1
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(12);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene12-shader-balls");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 12 skipped via skipParity in scene-config.json");

test("Scene 12 — PBR Shader Balls matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 12, seekTime: 0.5, timeout: 120_000 });

    await page.goto("/scene12.html?seekTime=0.5");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
