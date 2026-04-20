/**
 * Scene 40 — Physics V2 (Havok sphere drop) Parity Test
 *
 * Captures the Babylon Lite physics scene render and compares
 * against the golden reference (captured from Babylon.js with Havok).
 *
 * BJS reference: playground #Z8HTUN#1
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(40);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene40-physics");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 40 — Physics matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 40 });

    await page.goto("/scene40.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 50_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
