import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(57);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene57-cutout-billboards");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 57 skipped via skipParity in scene-config.json");

test("Scene 57 - Cutout billboards match Babylon.js alpha-test reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 57, settleMs: 500 });

    await page.goto("scene57.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    expect(full.mad, `Full-image MAD ${full.mad.toFixed(4)} exceeds ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
