/**
 * Scene 39 — KHR_animation_pointer (Animated Waterfall) Parity Test
 *
 * AnimatedWaterfall.gltf — every animated mesh is driven through
 * KHR_animation_pointer: the grass blades rotate via /nodes/{n}/rotation
 * pointers and the water/foam surfaces scroll via
 * /materials/{m}/.../KHR_texture_transform offset+scale pointers.
 *
 * Lit purely by the shared IBL environment (the model's animated spot lights
 * are dropped in both engines; Lite bakes punctual lights at load and cannot
 * reproduce the day/night animation). Explicit identical camera in both
 * engines for deterministic framing.
 *
 * Deterministic capture: seekTime freezes every animation group at frame
 * seekTime*60 so both BJS and Lite render an identical animated pose.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const SEEK_TIME = 5;
const sceneConfig = getSceneConfig(39);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene39-animation-pointer-waterfall");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 39 skipped via skipParity in scene-config.json");

test("Scene 39 — KHR_animation_pointer (Animated Waterfall) matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 39, seekTime: SEEK_TIME, timeout: 90_000 });

    await page.goto(`scene39.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 60_000 });
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
