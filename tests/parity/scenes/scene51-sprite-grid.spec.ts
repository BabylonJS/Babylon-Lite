/**
 * Scene 51 — Soft-Edged Sprite Grid (Premultiplied) Parity Test
 *
 * Compares Babylon Lite's premultiplied sprite codepath against BJS's
 * `SpriteRenderer` configured with `blendMode = ALPHA_PREMULTIPLIED`
 * and a pre-baked premultiplied atlas. Both renderers operate on
 * premultiplied storage with matching `srcFactor: ONE` blend factors,
 * so soft-edged sprites composite without the bright-halo artefact you
 * see when the two disagree.
 *
 * Golden is captured automatically from the BJS reference page on first
 * run (or when `RECAPTURE_GOLDEN=1` is set).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(51);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene51-sprite-grid");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 51 skipped via skipParity in scene-config.json");

test("Scene 51 — Soft-Edged Sprites (Premultiplied) matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 51 });

    // Force MSAA 4 to match BJS oracle's default; lab demo defaults to MSAA 1 for perf.
    await page.goto("/scene51.html?msaa=4");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
