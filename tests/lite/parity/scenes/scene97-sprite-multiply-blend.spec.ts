/**
 * Scene 97 — Sprite Multiply Blend Parity Test
 *
 * Compares Babylon Lite's `spriteBlendMultiply` (result = src * dst) over a light
 * clear colour against a Babylon.js SpriteRenderer oracle that pre-bakes the same
 * clear colour into the (opaque) atlas pixels and draws with straight-alpha blend.
 * The two are pixel-identical because the icon cells are fully opaque.
 *
 * Golden is captured automatically from the BJS reference page on first run
 * (or when RECAPTURE_GOLDEN=1 is set).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(97);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene97-sprite-multiply-blend");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 97 skipped via skipParity in scene-config.json");

test("Scene 97 — sprite multiply blend matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 97, settleMs: 500 });

    await page.goto("scene97.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
