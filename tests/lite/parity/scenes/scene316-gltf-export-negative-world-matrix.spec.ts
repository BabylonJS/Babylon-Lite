/**
 * Scene 316 — glTF export: negative world matrix
 *
 * Babylon.js visualization test: "GLTF Serializer with Negative World Matrix (left handed, twice)", run as `?iterations=2`.
 * Playground: #KX53VK#88. Reference image: glTFSerializerNegativeWorldMatrix.png (errorRatio 1.1), shared by all variants.
 *
 * Also covers "left handed, once": its single export and reload is the first iteration here and compares to the same golden.
 * Not ported: the two right-handed tests ("right handed, once / twice"); Lite has no right-handed scenes.
 * Not reproduced one-to-one: Lite has no per-material sideOrientation, so the "CW" triangles keep their vertices and
 * get reversed indices. The page opts into `enableDeviceLostSceneRecovery` so loaded meshes keep their vertex colors
 * for the second export (see the page and docs/lite/architecture/60-gltf-exporter.md, Scope). The snippet's
 * `shouldExportNode` excludes the light; Lite's exporter has no node filter, so the light joins after the round trips.
 */
import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(316);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene316-gltf-export-negative-world-matrix");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 316 skipped via skipParity in scene-config.json");

test("Scene 316 — GLTF Serializer with Negative World Matrix (left handed, twice) matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 316, timeout: 90_000 });

    await page.goto("/scene316.html?iterations=2");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 316 Lite", pollMs: 100 });
    // The scene is static and `ready` follows its first rendered frame, so remove the loader overlay
    // instead of waiting out its fade.
    await page.evaluate(() => document.getElementById("loader-overlay")?.remove());

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
