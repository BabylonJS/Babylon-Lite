/**
 * Scene 320 — glTF export: KHR_texture_transform
 *
 * Babylon.js visualization test: "Export GLTF Extension KHR_texture_transform"
 * Playground: #20OAV9#15148. Reference image: exportGltfKHRTextureTransform.png (errorRatio 1.1).
 *
 * Not reproduced one-to-one:
 * - The snippet exports with `shouldExportNode: node.name.startsWith("plane")`. Lite's exporter has no filter, so the
 *   hemispheric light and the camera are added to the scene after the export instead.
 * - Babylon.js `Texture.wAng` (rotation about the UV origin) is Lite's `Texture2D.uAng`, with the opposite sign.
 */
import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(320);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene320-gltf-export-texture-transform");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 320 skipped via skipParity in scene-config.json");

test("Scene 320 — Export GLTF Extension KHR_texture_transform matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 320, timeout: 90_000 });

    await page.goto("/scene320.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 320 Lite", pollMs: 100 });
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
