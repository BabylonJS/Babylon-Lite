/**
 * Scene 206 — Floating-Origin Cutout Billboards Parity Test.
 *
 * Renders hard-alpha (alpha-tested, depth-writing) world-space billboard sprite
 * cards at world (~5e6, *, ~5e6) with Lite's `useHighPrecisionMatrix: true` +
 * `useFloatingOrigin: true` and compares against the BJS reference
 * (`useLargeWorldRendering: true` + alpha-test facing planes). Exercises the
 * opaque/cutout billboard upload path (`uploadBillboardInstances`), which bakes
 * the active camera world position into every anchor and re-uploads when the
 * camera moves — crisp, jitter-free cutout cards at large coordinates.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(206);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene206-floating-origin-cutout-billboards");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 206 skipped via skipParity in scene-config.json");

test("Scene 206 — Floating-origin cutout billboards match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 206, settleMs: 500 });

    await page.goto("/scene206.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const useFO = await page.evaluate(() => document.querySelector("canvas")?.dataset.useFloatingOrigin);
    expect(useFO, "Scene 206 must report useFloatingOrigin=true on the canvas dataset").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 206 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
