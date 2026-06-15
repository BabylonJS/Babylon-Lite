/**
 * Scene 209 — Floating-origin Havok physics (multi-region) Parity Test
 *
 * Captures the Babylon Lite physics scene render at world (~5e6, *, ~5e6) and
 * compares against the golden reference (captured from Babylon.js with
 * useLargeWorldRendering + Havok multi-region floating origin).
 *
 * The body settles to a deterministic resting pose, so the screenshot is
 * stable regardless of exact stepping — mirroring the scene40 settle pattern.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(209);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene209-floating-origin-physics");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 209 skipped via skipParity in scene-config.json");

test("Scene 209 — Floating-origin physics matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 209 });

    await page.goto("/scene209.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 50_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
