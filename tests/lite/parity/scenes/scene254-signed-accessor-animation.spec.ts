/**
 * Scene 254 — Signed Accessor Animation Parity Test (glTF-Asset-Generator
 * Category A: signed BYTE / SHORT accessor component types).
 *
 * Loads Animation_SamplerType_01.gltf, whose rotation-animation sampler output
 * quaternions are stored as a normalized signed BYTE accessor (componentType
 * 5120). The loader used to throw "Unsupported component type: 5120 / 5122" on
 * these signed types. Golden is captured from BJS with ?seekTime=2.0 (frame 120
 * = -90° about Y); Lite uses the same seekTime.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 * - Rotated cube region MAD ≤ maxRegionMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(254);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene254-signed-accessor-animation");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 254 skipped via skipParity in scene-config.json");

test("Scene 254 — signed BYTE accessor animation matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 254, seekTime: 2.0, timeout: 120_000 });

    await page.goto("/scene254.html?seekTime=2.0");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Cube region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad, `Cube region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
