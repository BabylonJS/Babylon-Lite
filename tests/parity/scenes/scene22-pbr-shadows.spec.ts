/**
 * Scene 22 — PBR Shadows (DirectionalLight + ESM + PBR ground) Parity Test
 *
 * Copy of Scene 4 but with PBR material on the ground instead of Standard.
 * Validates that PBR materials correctly receive ESM shadows.
 *
 * Assertions:
 * - Full image MAD ≤ threshold from scene-config.json
 * - ≥99% of pixels within 5 bytes
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(22);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene22-pbr-shadows");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 22 — PBR Shadows matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 22 });

    await page.goto("/scene22.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(1000);

    // Hide interactive UI buttons so they don't leak into the canvas screenshot.
    await page.addStyleTag({ content: "button { display: none !important; }" });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤1: ${((100 * full.within1) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(full.within5 / full.totalPixels, "≥99% within 5 bytes").toBeGreaterThanOrEqual(0.99);
});
