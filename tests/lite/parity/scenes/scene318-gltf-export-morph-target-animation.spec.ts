/**
 * Scene 318 — glTF export of a textured sphere with two animated morph targets
 *
 * Babylon.js visualization test: "GLTF Serializer Morph Target Animation"
 * Playground: #84M2SR#107. Babylon.js reference image: gltfSerializerMorphTargetAnimation.png (errorRatio 1.1; the test is
 * excluded on WebGPU upstream, but the Babylon.js WebGPU render of this snippet matches that image, so the golden is
 * captured from the WebGPU reference page).
 *
 * Not reproduced as in the snippet: the morph targets are position/normal deltas rather than absolute positions, and the
 * two influence animations are not authored, because the Lite exporter exports only glTF-clip animation groups
 * (natively authored animations are not exportable). The test therefore covers morph-target export and reload, not
 * morph-animation export; the weights Babylon.js reaches at frame 60 (1.25, 1.25) are applied directly after the reload.
 * See the header of lab/lite/src/lite/scene318.ts.
 */
import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(318);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene318-gltf-export-morph-target-animation");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 318 skipped via skipParity in scene-config.json");

test("Scene 318 — GLTF Serializer Morph Target Animation matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 318, timeout: 90_000 });

    await page.goto("/scene318.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 318 Lite", pollMs: 100 });
    // The scene is static and `ready` follows its first rendered frame, so remove the loader overlay
    // instead of waiting out its fade.
    await page.evaluate(() => document.getElementById("loader-overlay")?.remove());

    const actual = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });

    const full = compareImages(actual, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, actual, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
