/**
 * Scene 218 — Vertex Animation Texture (VAT) Parity Test
 *
 * VAT must reproduce the LIVE skeletal animation. The golden is the same shark rendered with Babylon.js's
 * live skeleton (the scene-11 oracle), frozen at the integer frame seekTime*60. Lite scene 218 renders the
 * SAME pose from its baked VAT texture (full-precision rgba32float, exact integer frame row), so it must
 * match the live reference to the same tolerance as the live scene-11 parity test.
 *
 * Assertions:
 * - Full image MAD ≤ scene-config maxMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(218);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene218-vat");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const SEEK_TIME = "1.0"; // integer frame (60) so the baked VAT row matches the BJS live pose exactly

test.skip(!!sceneConfig.skipParity, "Scene 218 skipped via skipParity in scene-config.json");

test("Scene 218 — VAT shark matches Babylon.js live-skeleton reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 218, seekTime: Number(SEEK_TIME), timeout: 180_000 });

    await page.goto(`/scene218.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
