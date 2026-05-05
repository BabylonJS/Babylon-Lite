/**
 * Scene 110 — RTT with per-pass material override Parity Test
 *
 * Captures the Babylon Lite frame-graph multi-pass scene render and compares
 * against the golden reference (captured from Babylon.js using
 * RenderTargetTexture + setMaterialForRendering + per-RTT activeCamera).
 *
 * Scene id 110 — moved from id 52.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(110);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene110-rtt-override");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 110 — RTT with material override matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 110 });

    await page.goto("/scene110.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 50_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
