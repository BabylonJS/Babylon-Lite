/**
 * Scene 4 — Shadows (DirectionalLight + ESM) Parity Test
 *
 * Captures the Babylon Lite shadows scene with heightmap ground,
 * torus, sphere, and ESM shadow mapping, comparing against the
 * golden reference captured from Babylon.js playground #IIZ9UU.
 *
 * Assertions:
 * - Full image MAD ≤ 0.03
 * - ≥99% of pixels within 5 bytes
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(4);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene4-shadows");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 4 — Shadows matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 4 });

    await page.goto("/scene4.html");
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
