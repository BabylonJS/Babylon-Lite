/**
 * Scene 259 — Emissive Material Parity Test (glTF-Asset-Generator Category F:
 * base material / emissive).
 *
 * Loads Material_03.gltf: a flat plane with a dark base (baseColorFactor 0.2,
 * metallic 0) and a full-white emissiveFactor [1,1,1] but NO emissive texture.
 * Lite treated emissiveFactor [1,1,1] as a no-op (valid only with an emissive
 * texture to multiply), dropping the emissive so the surface rendered dark. The
 * loader now applies emissiveFactor when there is no emissive texture.
 *
 * Static scene; golden captured from BJS (generator manifest camera).
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 * - Plane region MAD ≤ maxRegionMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(259);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene259-material-emissive");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 259 skipped via skipParity in scene-config.json");

test("Scene 259 — emissive material matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 259, timeout: 120_000 });

    await page.goto("scene259.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Plane region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad, `Region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
