/**
 * Scene 20 — PBR Emissive Spheres Grid Parity Test
 *
 * 2500 PBR spheres with random seeded emissive colors, parent hierarchy.
 * Uses seekTime=0 to freeze at initial pose (no rotation).
 * MAD ceiling is 0.6 due to ±1 rounding noise across 2500 mirror-like spheres
 * (F0=1, roughness=0 makes cubemap decode precision visible on every pixel).
 *
 * Assertions:
 * - Full image MAD ≤ 0.6
 * - ≥5% exact match
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(20);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene20-emissive-grid");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 20 skipped via skipParity in scene-config.json");

test("Scene 20 — PBR Emissive Spheres Grid matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 20, seekTime: 0, timeout: 120_000 });

    await page.goto("/scene20.html?seekTime=0");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
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
    expect(full.exactMatch / full.totalPixels, "≥5% exact match").toBeGreaterThanOrEqual(0.05);
});
