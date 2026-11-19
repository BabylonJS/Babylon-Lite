/**
 * Scene 357 — Selective Glow (ShaderMaterial, PBR) Parity Test
 *
 * A ShaderMaterial without emissive source renders in the neutral color and occludes, another glows through
 * the color selector; a PBR emitter glows through a linear emissive texture and an unlit PBR cube occludes.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(357);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene357-glow-shader-material");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 357 skipped via skipParity in scene-config.json");

test("Scene 357 — ShaderMaterial and PBR glow match Babylon.js GlowLayer", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 357 });

    await page.goto("/scene357.html");
    await waitForCanvasReady(page, { timeout: 60_000, label: "Scene 357 Lite" });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
