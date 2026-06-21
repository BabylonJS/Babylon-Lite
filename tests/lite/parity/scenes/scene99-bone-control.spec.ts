/**
 * Scene 99 — Bone Control parity test.
 *
 * Loads Xbot.glb at bind pose (no animation) in both Babylon Lite and Babylon.js,
 * then hides the whole left arm by collapsing its bone sub-tree:
 *   - Lite:  enableBoneControl() + setBoneVisible(skel, leftArm, false)
 *   - BJS:   zero the bone's local 3x3 (keep bind translation) via updateMatrix()
 * Both produce an identical collapsed local matrix, so the same skinned triangles
 * degenerate and disappear. Validates the opt-in bone-control eager-bake pipeline
 * (skin extraction → hierarchy world matrices → bone texture → skinning) against BJS.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(99);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene99-bone-control");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 99 skipped via skipParity in scene-config.json");

test("Scene 99 — bone control (hide skinned sub-tree) matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 99, timeout: 120_000, settleMs: 500 });

    await page.goto("/scene99.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}, Xbot region=${region.regionPixels} px`);

    expect(region.regionPixels, "Reference should contain visible Xbot pixels").toBeGreaterThan(1_000);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
