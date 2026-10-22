/**
 * Scene 320 — GLTF Serializer KHR draco mesh compression
 *
 * Ports the Babylon.js visualization test "GLTF Serializer KHR draco mesh compression" (playground #F8BF8N#3, reference image glTFSerializerKhrDracoMeshCompression.png).
 * Babylon Lite exports the scene with exportSceneAsGlb, reloads the GLB with loadGltf and renders the reloaded scene;
 * the one Babylon.js reference render is the golden.
 *
 * Not reproduced: Draco compression (the Lite exporter writes plain accessors, compressed output is out of scope), and the
 * snippet's shouldExportNode filter (lights and the camera are added after the export instead).
 *
 * Assertions:
 * - Full image MAD ≤ scene-config.json maxMad
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(320);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene320-gltf-export-draco");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 320 skipped via skipParity in scene-config.json");

test("Scene 320 — GLTF Serializer KHR draco mesh compression matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 320, timeout: 90_000 });

    await page.goto("/scene320.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 320 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
