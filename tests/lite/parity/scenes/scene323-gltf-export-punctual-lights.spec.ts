/**
 * Scene 323 — glTF export: KHR_lights_punctual
 *
 * Babylon.js visualization test: "GLTF Serializer KHR punctual light, left-handed".
 * Playground: #FLXW8B#27 (`roundtrip = true; useRightHandedSystem = false`). Reference image: glTFSerializerKHRPunctualLightLH.png (errorRatio 1.1).
 *
 * Not ported: the right-handed test (Lite has no right-handed scenes).
 * Not reproduced one-to-one: the snippet's `falloffType = FALLOFF_GLTF` has no Lite counterpart (Lite lights use the PBR
 * material's physical falloff), and Lite's exporter clamps the spot angle of 30 rad to a 180-degree cone. The lights are
 * exported from a scene of their own because the exporter has no node filter.
 */
import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(323);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene323-gltf-export-punctual-lights");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 323 skipped via skipParity in scene-config.json");

test("Scene 323 — GLTF Serializer KHR punctual light, left-handed matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 323, timeout: 90_000 });

    await page.goto("/scene323.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 323 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
