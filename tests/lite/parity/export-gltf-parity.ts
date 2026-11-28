import * as path from "path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./parity-fixtures";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "./compare-utils";

export async function assertExportParity(page: Page, testInfo: TestInfo, sceneId: number, query = ""): Promise<void> {
    const sceneConfig = getSceneConfig(sceneId);
    const referenceDir = path.resolve(__dirname, "../../../reference/lite", sceneConfig.slug);
    const golden = path.join(referenceDir, "babylon-ref-golden.png");
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId, timeout: 90_000 });
    await page.goto(`/scene${sceneId}.html${query}`);
    await waitForCanvasReady(page, { timeout: 90_000, label: `Scene ${sceneId} Lite`, pollMs: 100 });
    // These static scenes signal ready after their first frame; remove the loader rather than waiting for its fade.
    await page.evaluate(() => document.getElementById("loader-overlay")?.remove());
    const screenshot = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshot });
    const full = compareImages(screenshot, golden);
    await attachCompareArtifacts(testInfo, screenshot, golden, referenceDir);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
}
