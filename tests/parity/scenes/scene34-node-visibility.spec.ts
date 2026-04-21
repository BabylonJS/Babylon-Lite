/**
 * Scene 34 — KHR_node_visibility + KHR_animation_pointer Parity Test
 *
 * CubeVisibility.glb — three cubes: green always-visible, blue blinking
 * via KHR_animation_pointer on its visibility flag, two reds hidden via
 * KHR_node_visibility. Default IBL environment (no skybox, no ground).
 * Matches Babylon playground #YG3BBF#55.
 *
 * Deterministic capture: seekTime=0 freezes every animation group at
 * frame 0 so both BJS and Lite render an identical visibility state.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(34);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene34-node-visibility");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 34 skipped via skipParity in scene-config.json");

test("Scene 34 — KHR_node_visibility + KHR_animation_pointer matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 34, seekTime: 0, timeout: 60_000 });

    await page.goto("/scene34.html?seekTime=0");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

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
