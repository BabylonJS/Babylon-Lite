import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(129);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene129-gs-gpu-picking");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 129 skipped via skipParity in scene-config.json");

test("Scene 129 — GS GPU picking matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 129, timeout: 150_000, settleMs: 800 });

    await page.goto("/scene129.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 150_000 });
    await page.waitForFunction(() => !document.getElementById("loader-overlay"), { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}  within1=${((100 * full.within1) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);

    // Picking parity: the deterministic pick should land on the GS mesh
    // (named "renderMesh") in both Lite and BJS, validating the picker
    // integration end-to-end.
    const pickedHit = await page.locator("canvas").evaluate((c) => (c as HTMLCanvasElement).dataset.pickedHit);
    console.log(`Picked hit: ${pickedHit}`);
    expect(pickedHit, "Default deterministic pick should land on the GS mesh").toBe("renderMesh");
});
