/**
 * Scene 255 — Skin Weights (Byte) Parity Test (glTF-Asset-Generator Category B:
 * skinning blank for non-float JOINTS/WEIGHTS accessor types).
 *
 * Loads Animation_SkinType_01.gltf, a skinned plane whose vertex WEIGHTS are a
 * normalized UNSIGNED_BYTE accessor (componentType 5121). Lite used to read the
 * weights raw (0..255) instead of denormalizing to 0..1, exploding the skin and
 * rendering blank. Golden is captured from BJS with ?seekTime=1.0 (frame 60 =
 * the middle keyframe); Lite uses the same seekTime.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 * - Deformed-plane region MAD ≤ maxRegionMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(255);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene255-skin-weights-byte");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 255 skipped via skipParity in scene-config.json");

test("Scene 255 — normalized-byte skin weights match Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 255, seekTime: 1.0, timeout: 120_000 });

    await page.goto("scene255.html?seekTime=1.0");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Deformed-plane region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad, `Region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
