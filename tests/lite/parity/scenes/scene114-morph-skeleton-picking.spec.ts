/**
 * Scene 114 — Morph/Skeleton Picking Parity Test
 *
 * The scene places visible markers from actual GPU and detailed pick results
 * on morphed and skinned geometry, so the golden validates deformation-aware
 * hit selection plus face/barycentric details.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(114);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene114-morph-skeleton-picking");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 114 — Morph/Skeleton Picking matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(90_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 114, timeout: 90_000, settleMs: 1_000 });

    await page.goto("scene114.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 90_000 });
    await page.waitForTimeout(500);

    const hitState = await page.locator("canvas").evaluate((canvas) => ({
        morphGpuHit: (canvas as HTMLCanvasElement).dataset.morphGpuHit,
        morphDetailedHit: (canvas as HTMLCanvasElement).dataset.morphDetailedHit,
        skeletonGpuHit: (canvas as HTMLCanvasElement).dataset.skeletonGpuHit,
        skeletonDetailedHit: (canvas as HTMLCanvasElement).dataset.skeletonDetailedHit,
    }));
    expect(hitState.morphGpuHit).toBe("scene114-morph-target");
    expect(hitState.morphDetailedHit).toBe("scene114-morph-target");
    expect(hitState.skeletonGpuHit).toBe("scene114-skeleton-target");
    expect(hitState.skeletonDetailedHit).toBe("scene114-skeleton-target");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
