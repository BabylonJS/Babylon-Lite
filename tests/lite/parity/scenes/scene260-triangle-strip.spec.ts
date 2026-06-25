/**
 * Scene 260 — Triangle Strip Parity Test (glTF-Asset-Generator Category C:
 * non-triangle primitive topologies).
 *
 * Loads Mesh_PrimitiveMode_11.gltf: a quad drawn as a TRIANGLE_STRIP (primitive
 * mode 5) with uint32 indices. Lite hardcoded a triangle-list pipeline, so
 * POINTS / LINES / LINE_STRIP / TRIANGLE_STRIP primitives were interpreted as
 * triangle lists and rendered garbled (an "X"). The loader now reads the glTF
 * primitive `mode` and the PBR pipeline honors the matching WebGPU topology
 * (with stripIndexFormat for indexed strips).
 *
 * Static scene; golden captured from BJS (generator manifest camera).
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 * - Strip region MAD ≤ maxRegionMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(260);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene260-triangle-strip");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 260 skipped via skipParity in scene-config.json");

test("Scene 260 — triangle-strip topology matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 260, timeout: 120_000 });

    await page.goto("/scene260.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    console.log(`Strip region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}`);

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad, `Region MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
