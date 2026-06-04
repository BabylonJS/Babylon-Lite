/**
 * Scene 205 — Floating-Origin Facing Billboards Parity Test.
 *
 * Renders world-space camera-facing billboard sprite cards at world
 * (~5e6, *, ~5e6) with Lite's `useHighPrecisionMatrix: true` +
 * `useFloatingOrigin: true` and compares against the BJS reference
 * (`useLargeWorldRendering: true` + SpriteManager). The billboard upload bakes
 * the active camera world position into every anchor, so the GPU receives
 * eye-relative positions that match the eye-relative view-projection — crisp,
 * jitter-free cards. Exercises the sorted/transparent billboard upload path.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(205);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene205-floating-origin-facing-billboards");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 205 skipped via skipParity in scene-config.json");

test("Scene 205 — Floating-origin facing billboards match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 205, settleMs: 500 });

    await page.goto("/scene205.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const useFO = await page.evaluate(() => document.querySelector("canvas")?.dataset.useFloatingOrigin);
    expect(useFO, "Scene 205 must report useFloatingOrigin=true on the canvas dataset").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 205 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
