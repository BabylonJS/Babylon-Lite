/**
 * Scene 319 — glTF export: rotation conversion
 *
 * Babylon.js visualization test: "GLTF Serializer Rotation conversion, left-handed".
 * Playground: #UK7FLI#1. Reference image: glTFSerializerRotationConversionLH.png (errorRatio 1.1).
 *
 * Not ported: the snippet's right-handed variant (Lite has no right-handed scenes).
 * Not reproduced one-to-one: the light and camera values Babylon.js's createDefaultLight / createDefaultCamera produce are
 * set explicitly, and the material-less boxes get an explicit default StandardMaterial (Babylon.js exports its default material).
 */
import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(319);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene319-gltf-export-rotation-conversion");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 319 skipped via skipParity in scene-config.json");

test("Scene 319 — GLTF Serializer Rotation conversion, left-handed matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 319, timeout: 90_000 });

    await page.goto("/scene319.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 319 Lite", pollMs: 100 });
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
