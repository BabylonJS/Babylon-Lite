/**
 * Scene 265 — EnvironmentTest / glTF-IBL (cx20 gltf-test parity).
 *
 * Exercises the EXT_lights_image_based glTF extension: the model carries its own
 * document-level image-based light (irradiance SH9 + prefiltered specular cubemap
 * mips), which Lite drives through its existing environment/IBL path.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(265);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene265-environment-test");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 265 skipped via skipParity in scene-config.json");

test("Scene 265 — EnvironmentTest matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 265, timeout: 90_000 });

    await page.goto("/scene265.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
