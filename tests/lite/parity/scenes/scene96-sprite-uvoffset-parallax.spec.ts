/**
 * Scene 96 — Sprite uvOffset Parallax Parity Test
 *
 * Compares Babylon Lite's per-sprite `uvOffset` (uvScroll) rendering against a
 * Babylon.js SpriteRenderer oracle that bakes the same per-band offset into a
 * rolled-tile atlas (one cell per offset). With nearest sampling and
 * 1-texel-per-pixel sprites the two are pixel-identical.
 *
 * Golden is captured automatically from the BJS reference page on first run
 * (or when RECAPTURE_GOLDEN=1 is set).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(96);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene96-sprite-uvoffset-parallax");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 96 skipped via skipParity in scene-config.json");

test("Scene 96 — sprite uvOffset parallax matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 96, settleMs: 500 });

    await page.goto("scene96.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
