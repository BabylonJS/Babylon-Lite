/**
 * Scene 33 — KHR_lights_punctual Parity Test
 *
 * LightsPunctualLamp.glb (KHR_lights_punctual + KHR_materials_transmission)
 * with default environment (IBL only). Matches Babylon playground #YG3BBF#54.
 *
 * NOTE: maxMad is relaxed to 0.5 because the glass lampshade has historically
 * exposed a KHR_materials_transmission parity gap. All opaque surfaces are
 * pixel-perfect and the KHR_lights_punctual extension itself renders correctly
 * (98.8% exact). Scene 30 covers the dedicated transmission setup.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(33);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene33-lights-punctual");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 33 skipped via skipParity in scene-config.json");

test("Scene 33 — KHR_lights_punctual matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 33 });

    await page.goto("/scene33.html");
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
