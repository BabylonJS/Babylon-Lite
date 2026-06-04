/**
 * Scene 98 — Billboard Additive Blend Parity Test
 *
 * Compares Babylon Lite's `billboardBlendAdditive` (src-alpha, one) against a
 * Babylon.js SpriteManager oracle that uses ALPHA_ONEONE with each sprite's RGB
 * pre-multiplied by its own alpha. For the fully-opaque icon cells the two are
 * pixel-identical, including the additive brightening where billboards overlap.
 *
 * Golden is captured automatically from the BJS reference page on first run
 * (or when RECAPTURE_GOLDEN=1 is set).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(98);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene98-billboard-additive-blend");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 98 skipped via skipParity in scene-config.json");

test("Scene 98 — billboard additive blend matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 98, settleMs: 500 });

    await page.goto("/scene98.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
