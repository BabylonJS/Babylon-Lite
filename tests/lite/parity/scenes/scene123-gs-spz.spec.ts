/**
 * Scene 123 — Gaussian Splatting SPZ parity test.
 *
 * Loads hornedlizard.spz through `loadSPZ()` and compares against a
 * Babylon.js reference (captured on-the-fly via `ImportMeshAsync`
 * with `spzLibraryUrl: undefined`, matching playground XSNFXP#12).
 *
 * Both engines render with view-dependent SH shading. Asserts full-
 * image MAD ≤ `sceneConfig.maxMad`.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(123);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene123-gs-spz");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 123 skipped via skipParity in scene-config.json");

test("Scene 123 — Gaussian Splatting SPZ matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 123, timeout: 150_000, settleMs: 800 });

    await page.goto("scene123.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 150_000 });
    await page.waitForFunction(() => !document.getElementById("loader-overlay"), { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}  within1=${((100 * full.within1) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
