/**
 * Scene 8 — HDR Glass Sphere Parity Test
 *
 * Captures the Babylon Lite glass sphere scene and compares against
 * the golden reference image.
 *
 * Scene features: HDR environment (room.hdr), PBR glass sphere with
 * alpha=0.5, roughness=0, custom exposure/contrast.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(8);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene8-glass-sphere");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 8 skipped via skipParity in scene-config.json");

test("Scene 8 — HDR Glass Sphere matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000); // HDR loading + compute takes time

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 8, timeout: 120_000 });

    await page.goto("/scene8.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
