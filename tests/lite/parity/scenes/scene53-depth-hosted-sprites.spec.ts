/**
 * Scene 53 — Depth-Hosted Sprites Mixed With 3D Parity Test.
 *
 * Compares Babylon Lite's screen-space Sprite2DLayer depth path against a BJS
 * SpriteManager reference with world-space sprite positions derived from the
 * same projected pixel centers and NDC depths.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(53);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene53-depth-hosted-sprites");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 53 skipped via skipParity in scene-config.json");

test("Scene 53 — Depth-hosted sprites mixed with 3D matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 53, settleMs: 500 });

    await page.goto("/scene53.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
