/**
 * Scene 207 — Floating-Origin Directional Shadows Parity Test.
 *
 * Renders a directional-light PCF shadow (sphere + boxes casting onto a ground
 * receiver) at world (~5e6, *, ~5e6) with Lite's `useHighPrecisionMatrix: true`
 * + `useFloatingOrigin: true` and compares against the BJS reference
 * (`useLargeWorldRendering: true`). Exercises the shadow light-space matrix
 * under floating origin: the PCF directional generator builds its light
 * view/projection eye-relative (camera offset subtracted from the light
 * position and caster AABBs) so the shadow matches the eye-relative mesh world
 * matrices used by both the caster pass and the receiver shader.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(207);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene207-floating-origin-directional-shadows");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 207 skipped via skipParity in scene-config.json");

test("Scene 207 — Floating-origin directional shadows match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 207, settleMs: 500 });

    await page.goto("/scene207.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const useFO = await page.evaluate(() => document.querySelector("canvas")?.dataset.useFloatingOrigin);
    expect(useFO, "Scene 207 must report useFloatingOrigin=true on the canvas dataset").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 207 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
