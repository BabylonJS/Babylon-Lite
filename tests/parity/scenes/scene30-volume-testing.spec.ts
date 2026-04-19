/**
 * Scene 30 — KHR_materials_volume_testing Parity Test
 *
 * Khronos volume/transmission testing glb against the default IBL environment.
 * Matches Babylon playground #YG3BBF#16. V1 uses env-only refraction (samples
 * IBL specular cube at Snell-refracted direction + Beer-Lambert absorption
 * from KHR_materials_volume attenuation). Full opaque-scene RTT refraction is
 * a follow-up; MAD ceiling accommodates the V1 env-only approximation.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(30);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene30-volume-testing");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 30 — KHR_materials_volume_testing matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 30 });

    await page.goto("/scene30.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(1000);

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
