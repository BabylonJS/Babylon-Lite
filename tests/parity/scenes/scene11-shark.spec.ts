/**
 * Scene 11 — Shark GLB Parity Test
 *
 * Golden reference was captured from BJS with ?seekTime=1.91 to freeze
 * the animation at a deterministic pose. Lite uses the same seekTime.
 *
 * Assertions:
 * - Full image MAD ≤ 1
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(11);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene11-shark");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const SEEK_TIME = "1.91";

test.skip(!!sceneConfig.skipParity, "Scene 11 skipped via skipParity in scene-config.json");

test("Scene 11 — Shark GLB matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 11, seekTime: 1.91, timeout: 120_000 });

    await page.goto(`/scene11.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
