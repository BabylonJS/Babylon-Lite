/**
 * Scene 266 — Negative Scale, Double-Sided Materials (Khronos NegativeScaleTest).
 *
 * Loads NegativeScaleTest.glb: a grid of double-sided PBR material spheres, each
 * rendered as an un-mirrored copy and a negative-determinant (mirrored) copy.
 *
 * Lite reversed triangle winding on mirrored meshes by flipping the pipeline cull
 * face (cullMode "front") while keeping frontFace "ccw". That left WebGPU's
 * @builtin(front_facing) evaluated against the un-mirrored winding, so the
 * double-sided shader's front-facing normal flip inverted the (already correct)
 * outward normal on the visible surface of every mirrored sphere -> N·V < 0 ->
 * the reflective spheres rendered black. The loader now reverses winding by
 * flipping frontFace (ccw->cw), matching BJS's sideOrientation flip, so
 * front_facing stays consistent with the geometry.
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

const sceneConfig = getSceneConfig(266);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene266-negative-scale-doublesided");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 266 skipped via skipParity in scene-config.json");

test("Scene 266 — negative-scale double-sided matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 266, timeout: 120_000 });

    await page.goto("/scene266.html");
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
