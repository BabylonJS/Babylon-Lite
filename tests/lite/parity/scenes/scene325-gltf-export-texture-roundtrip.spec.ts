/**
 * Scene 325 — glTF export: texture round trip
 *
 * Babylon.js visualization test: "GLTF Serializer un/compressed texture roundtrip" (`roundtrip = true`)
 * Playground: #8NTR5X#8. Reference image: glTFSerializerTextureExport.png (errorRatio 0.1).
 *
 * Not reproduced one-to-one:
 * - Babylon.js sets `debugMode = 20` (PBR albedo debug view) on every reloaded material; Lite uses setPbrUnlit.
 * - The four Texture creation methods (constructor, updateURL, updateURL with a data: URL and bytes) collapse into
 *   URL loads and Blob-URL loads, because Lite has a single loader per format.
 * - The exporter re-encodes every image as PNG, so the KTX2 texture loses its stored mip chain on reload
 *   (see docs/lite/architecture/60-gltf-exporter.md, Scope).
 */
import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(325);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene325-gltf-export-texture-roundtrip");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 325 skipped via skipParity in scene-config.json");

test("Scene 325 — GLTF Serializer un/compressed texture roundtrip matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await captureGolden(page.context().browser()!, { sceneId: 325, timeout: 90_000 });

    await page.goto("/scene325.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 325 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
