import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(56);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene56-axis-locked-billboards");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 56 skipped via skipParity in scene-config.json");

test("Scene 56 — Axis-locked billboards match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 56, settleMs: 500 });

    await page.goto("/scene56.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    expect(full.mad, `Full-image MAD ${full.mad.toFixed(4)} exceeds ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
