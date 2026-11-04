/**
 * Scene 353 — Bent Normals Parity Test (right-handed twin of scene 230)
 *
 * Same Lite code as scene 230, built right-handed; the golden is the Babylon.js
 * reference with `useRightHandedSystem = true`.
 *
 * The same glTF is rendered twice; only the right copy has a tangent-space
 * `bentNormalTexture`, which replaces the default specular occlusion with the
 * spherical-Gaussian bent-normal reflection occlusion term.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(353);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene353-rh-bent-normals");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 353 skipped via skipParity in scene-config.json");

test("Scene 353 — bent normal reflection occlusion matches right-handed Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 353 });

    await page.goto("/scene353.html");
    await waitForCanvasReady(page, { timeout: 60_000, label: "Scene 353 Lite" });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF, [31, 31, 31], 10);
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Model region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}, within-5=${((100 * region.within5) / region.regionPixels).toFixed(1)}%`);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(region.regionPixels, "The reference models should occupy a visible region").toBeGreaterThan(10_000);
    expect(region.mad, `Model region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
