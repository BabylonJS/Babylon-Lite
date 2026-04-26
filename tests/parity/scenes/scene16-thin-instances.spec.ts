/**
 * Scene 16 — Thin Instances (64K Cubes) Parity Test
 *
 * Captures the Babylon Lite scene with 64,000 thin-instanced cubes
 * with per-instance color, comparing against the golden reference.
 *
 * Assertions:
 * - Full image MAD ≤ 1
 * - ≥95% exact match
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(16);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene16-thin-instances");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 16 skipped via skipParity in scene-config.json");

test("Scene 16 — Thin Instances matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 16 });

    await page.goto("/scene16.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(1000);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤1: ${((100 * full.within1) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(full.exactMatch / full.totalPixels, "≥95% exact match").toBeGreaterThanOrEqual(0.95);
});
