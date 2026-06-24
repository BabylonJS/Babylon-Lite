/**
 * Scene 258 — Interleaved UV Parity Test (glTF-Asset-Generator Category E:
 * interleaved buffers / normalized non-float vertex attributes).
 *
 * Loads Buffer_Interleaved_03.gltf: a textured plane whose POSITION, COLOR_0 and
 * TEXCOORD_0 are interleaved in one bufferView, with TEXCOORD_0 stored as a
 * normalized UNSIGNED_BYTE accessor. Lite bound the integer UVs raw to the
 * float32x2 vertex layout, garbling them and mis-mapping the texture. The loader
 * now denormalizes non-float TEXCOORD to a tight float32x2 [0,1] buffer.
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

const sceneConfig = getSceneConfig(258);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene258-interleaved-uv");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 258 skipped via skipParity in scene-config.json");

test("Scene 258 — interleaved normalized-byte UVs match Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 258, timeout: 120_000 });

    await page.goto("/scene258.html");
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
