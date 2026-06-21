/**
 * Scene 251 — AnimationGroupMask (Xbot Walk, Frozen Legs) Parity Test
 *
 * Xbot plays only its "walk" clip with an AnimationGroupMask in Exclude mode
 * listing the lower-body bones (legs + feet/toes). Everything animates except
 * those, so the hips, spine, and arms walk while the legs hold their bind pose.
 * Babylon.js applies the same AnimationGroupMask (and removeUnmaskedAnimations
 * so its goToFrame poses only the retained bones), so both engines render the
 * identical masked pose, frozen at a deterministic frame.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const SEEK_TIME = 0.5;
const sceneConfig = getSceneConfig(251);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene251-animation-mask");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 251 skipped via skipParity in scene-config.json");

test("Scene 251 — Animation Mask (Xbot walk, frozen legs) matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 251, seekTime: SEEK_TIME, timeout: 90_000 });

    await page.goto(`/scene251.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 60_000 });
    await page.waitForTimeout(300);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
