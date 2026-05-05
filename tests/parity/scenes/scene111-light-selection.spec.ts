/**
 * Scene 111 — Light Selection Stress Test Parity Test
 *
 * Exercises the scene-wide lights UBO and mesh-level light selection across
 * StandardMaterial, PBRMaterial, NodeMaterial, and mixed ESM/PCF shadows.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(111);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene111-light-selection");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 111 skipped via skipParity in scene-config.json");

test("Scene 111 — Light Selection Stress Test matches Babylon.js reference", async ({ page }, testInfo) => {
    await page.goto("/scene111.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(1000);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
