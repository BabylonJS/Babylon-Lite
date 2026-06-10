/**
 * Scene 16 — GPU-Culling Correctness Parity Test
 *
 * Loads scene16 with `?culling`, which enables GPU thin-instance culling
 * (drawIndexedIndirect over a compute-compacted visible-instance buffer).
 * GPU culling only removes off-screen instances, so the visible image MUST be
 * pixel-identical to the non-culled scene16 render. This is the regression
 * guard proving the Standard culling path produces correct pixels.
 *
 * Reuses scene16's golden — no separate reference.
 *
 * Assertions:
 * - canvas.dataset.gpuCulling === "thin-instances"
 * - Full image MAD ≤ scene16 maxMad
 * - ≥95% exact match
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(16);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene16-thin-instances");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 16 skipped via skipParity in scene-config.json");

test("Scene 16 — GPU culling renders identically to non-culled golden", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    // Golden is scene16's (shared); capture if missing.
    await captureGolden(browser, { sceneId: 16 });

    await page.goto("/scene16.html?culling");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(1000);

    const gpuCulling = await page.evaluate(() => document.querySelector("canvas")?.dataset.gpuCulling);
    expect(gpuCulling, "GPU culling must be active").toBe("thin-instances");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual-culling.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Culled image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(full.exactMatch / full.totalPixels, "≥95% exact match vs non-culled golden").toBeGreaterThanOrEqual(0.95);
});
