/**
 * Scene 267 — StandardMaterial Vertex Colors.
 *
 * A full-frame affine RGBA vertex-color gradient isolates StandardMaterial's
 * color attribute, interpolation, and base-color multiplication.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(267);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene267-standard-vertex-colors");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 267 skipped via skipParity in scene-config.json");

test("Scene 267 — StandardMaterial vertex colors match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 267 });

    await page.goto("/scene267.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(100);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
