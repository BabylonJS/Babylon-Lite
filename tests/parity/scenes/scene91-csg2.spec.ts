import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(91);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene91-csg2");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 91 skipped via skipParity in scene-config.json");

test("Scene 91 — CSG2 operations match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 91, timeout: 90_000, settleMs: 1000 });

    await page.goto("/scene91.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
