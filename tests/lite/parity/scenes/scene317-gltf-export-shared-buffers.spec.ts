/**
 * Scene 317 — glTF export: shared buffer conversions
 *
 * Babylon.js visualization test: "GLTF Serializer Shared Buffer Conversions".
 * Playground: #KX53VK#85 (`meshCount = 2`). Reference image: glTFSerializerSharedBufferConversions.png (errorRatio 1.1).
 *
 * Reproduced as written, except that the light joins after the round trip (the snippet's `shouldExportNode` excludes it;
 * Lite's exporter has no node filter). The two meshes are built from the same typed arrays, so the exporter sees one
 * shared geometry.
 */
import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(317);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene317-gltf-export-shared-buffers");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 317 skipped via skipParity in scene-config.json");

test("Scene 317 — GLTF Serializer Shared Buffer Conversions matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 317, timeout: 90_000 });

    await page.goto("/scene317.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 317 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
