/**
 * Scene 204 — Floating-Origin Thin Instances Parity Test
 *
 * Renders a thin-instanced box at world (~5e6, 1, ~5e6) with Lite's
 * `useHighPrecisionMatrix: true` + `useFloatingOrigin: true` and compares
 * against the BJS reference (`useLargeWorldRendering: true`). Both stacks
 * compose `finalWorld = mesh.world * instanceMatrix`, so the large world
 * coordinate is carried by the eye-relative `mesh.world` and instance
 * matrices stay local — crisp instanced geometry with no F32 jitter.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(204);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene204-floating-origin-thin-instances");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 204 skipped via skipParity in scene-config.json");

test("Scene 204 — Floating-origin thin instances match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 204 });

    await page.goto("/scene204.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const useFO = await page.evaluate(() => document.querySelector("canvas")?.dataset.useFloatingOrigin);
    expect(useFO, "Scene 204 must report useFloatingOrigin=true on the canvas dataset").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 204 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
