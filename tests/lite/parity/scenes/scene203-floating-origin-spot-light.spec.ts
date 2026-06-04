/**
 * Scene 203 — Floating-Origin Spot Light Parity Test
 *
 * Renders a spot-lit scene at world (~5e6, *, ~5e6) with Lite's
 * `useHighPrecisionMatrix: true` + `useFloatingOrigin: true` and compares
 * against the BJS reference (`useLargeWorldRendering: true`). Both stacks
 * bake the active camera position into the spot-light position (direction
 * untouched) so the GPU shades with an eye-relative light position — a
 * crisp, stable light cone with no F32 cancellation jitter.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(203);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene203-floating-origin-spot-light");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 203 skipped via skipParity in scene-config.json");

test("Scene 203 — Floating-origin spot light matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 203 });

    await page.goto("/scene203.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const useFO = await page.evaluate(() => document.querySelector("canvas")?.dataset.useFloatingOrigin);
    expect(useFO, "Scene 203 must report useFloatingOrigin=true on the canvas dataset").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 203 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
