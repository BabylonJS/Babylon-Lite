/**
 * Scene 201 — High-Precision Matrix Jitter (HPM **on**, FO **on**) Parity Test
 *
 * Renders the shared HPM-jitter scene with Lite's `useHighPrecisionMatrix:
 * true` + `useFloatingOrigin: true` and compares against the BJS reference
 * which sets `useLargeWorldRendering: true` (BJS bundles HPM + floating
 * origin behind a single flag). Both stacks should render the (~5e6, *, ~5e6)
 * world crisply.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(201);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene201-high-precision-jitter-hpm-on");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 201 skipped via skipParity in scene-config.json");

test("Scene 201 — HPM Jitter (HPM on) matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 201 });

    await page.goto("/scene201.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    // Validate the engine actually enabled HPM — guards against silent
    // regression of the engine option plumbing.
    const useHpm = await page.evaluate(() => document.querySelector("canvas")?.dataset.useHighPrecisionMatrix);
    expect(useHpm, "Scene 201 must report useHighPrecisionMatrix=true on the canvas dataset").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 201 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
