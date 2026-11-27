/**
 * Scene 356 — Selective Glow Parity Test
 *
 * GlowPostProcessTask over Standard/PBR emitters, a NodeMaterial whose FragmentOutput glow input renders
 * through its own vertex-stretched shader, and NodeMaterial/Standard occluders, against the classic
 * Babylon.js GlowLayer.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(356);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene356-glow");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 356 skipped via skipParity in scene-config.json");

test("Scene 356 — selective glow matches Babylon.js GlowLayer", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 356 });

    await page.goto("/scene356.html");
    await waitForCanvasReady(page, { timeout: 60_000, label: "Scene 356 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
