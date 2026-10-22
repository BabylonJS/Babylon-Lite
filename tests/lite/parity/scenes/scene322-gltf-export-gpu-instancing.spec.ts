/**
 * Scene 322 — GLTF Serializer KHR gpu instancing
 *
 * Ports the Babylon.js visualization test "GLTF Serializer KHR gpu instancing" (playground #1Q2BWN#10, reference image glTFSerializerKhrGpuInstancing.png).
 * Babylon Lite exports the scene with exportSceneAsGlb, reloads the GLB with loadGltf and renders the reloaded scene;
 * the one Babylon.js reference render is the golden.
 *
 * Only the reloaded scene is rendered, as in the Babylon.js harness; the source scene is never rendered.
 *
 * Threshold: Lite renders TeapotsGalore's metallic PBR material (metallic 0.8, roughness 0.5) under the hemispheric light
 * brighter than Babylon.js (MAD ≈ 5.92), identically with and without the export step, so the gap is in the renderer,
 * not the exporter. `maxMad` covers it until that is fixed; it guards the export path against regressions meanwhile.
 *
 * Assertions:
 * - Full image MAD ≤ scene-config.json maxMad
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(322);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene322-gltf-export-gpu-instancing");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 322 skipped via skipParity in scene-config.json");

test("Scene 322 — GLTF Serializer KHR gpu instancing matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await captureGolden(page.context().browser()!, { sceneId: 322, timeout: 180_000 });

    await page.goto("/scene322.html");
    await waitForCanvasReady(page, { timeout: 180_000, label: "Scene 322 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
