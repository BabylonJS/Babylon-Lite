/**
 * Scene 257 — Negative Node Scale Parity Test (glTF-Asset-Generator Category D).
 *
 * Loads Node_NegativeScale_01.gltf: two textured shapes, one with an identity
 * transform and one with a mirror matrix (negative determinant). Lite's
 * back-face culling culled the wrong faces on the mirrored copy (rendered
 * inside-out), because a negative-determinant world transform reverses triangle
 * winding relative to the RH->LH root flip. The loader now reverses the winding
 * for positive-determinant world matrices.
 *
 * Static scene; golden captured from BJS (generator manifest camera).
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 * - Foreground region MAD ≤ maxRegionMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(257);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene257-negative-node-scale");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 257 skipped via skipParity in scene-config.json");

test("Scene 257 — negative node scale matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 257, timeout: 120_000 });

    await page.goto("scene257.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Foreground region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad, `Region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
