// Parity test for Scene 261 — Temporal Anti-Aliasing.
//
// Renders three tilted boxes through the frame-graph TAA chain (source render task →
// `createTaaPostProcessTask` → swapchain), lets the temporal accumulation converge over
// many frames, then freezes and screenshots. Asserts the converged Lite output matches
// the Babylon.js `TAARenderingPipeline` golden within the scene's full-image MAD ceiling.
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(261);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene261-temporal-anti-aliasing");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 261 skipped via skipParity in scene-config.json");

test("Scene 261 — Frame-graph TAA matches Babylon.js TAARenderingPipeline reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 261, timeout: 120_000 });

    await page.goto("/scene261.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
