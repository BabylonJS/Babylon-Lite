/**
 * Scene 280 — Mirrored Double-Sided Winding Parity Test.
 *
 * Two identical double-sided quads under an IBL, one of them under a negative-scale node so its
 * net world determinant is positive and its triangle winding reversed relative to the loader's
 * RH->LH `__root__` flip.
 *
 * A mirrored mesh must have its pipeline `frontFace` flipped ccw->cw. WebGPU derives
 * `@builtin(front_facing)` from `frontFace`, and the double-sided PBR shader flips the shading
 * normal on fragments that are not front-facing, so the wrong winding inverts the outward normal
 * on the visible side. Babylon.js flips `sideOrientation` for the same reason, which is why its
 * reference shades both quads consistently — and why a build that loses the winding misses it.
 *
 * This scene exists because the mirrored-node scenes that came before it (257 / 266 / 269) do NOT
 * catch the failure: their mirrored meshes render pixel-identically whether the winding is applied
 * or not (verified by forcing the wrong winding and re-rendering). It is also specifically a
 * BUNDLED-build regression — the winding used to be installed through a bare side-effect import
 * that the scene bundler tree-shakes away, so a source build always looked correct.
 *
 * Static scene; golden captured from BJS.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 * - Foreground region MAD ≤ maxRegionMad
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(280);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene280-mirrored-doublesided-winding");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 280 skipped via skipParity in scene-config.json");

test("Scene 280 — mirrored double-sided winding matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 280, timeout: 120_000 });

    await page.goto("/scene280.html");
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
