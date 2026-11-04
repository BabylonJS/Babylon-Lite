import { expect, test } from "../parity-fixtures";
import * as path from "path";
import type { Page } from "@playwright/test";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(283);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene283-npe-multiply-blend");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 283 skipped via skipParity in scene-config.json");

test("Scene 283 - NPE Multiply blend matches Babylon.js", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 283, waitFlag: "animationFrozen", settleMs: 300 });

    await page.goto("/scene283.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(200);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});

async function expectAnimatedCanvas(page: Page, url: string): Promise<void> {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    const canvas = page.locator("canvas");
    await expect(canvas).not.toHaveAttribute("data-animation-frozen", "true");
    const firstFrame = await canvas.screenshot();
    await page.waitForTimeout(600);
    const secondFrame = await canvas.screenshot();
    expect(secondFrame.equals(firstFrame), `${url} should continue rendering changing particle frames`).toBe(false);
}

test("Scene 283 - live Multiply particles animate in Lite and Babylon.js", async ({ page }) => {
    await expectAnimatedCanvas(page, "/scene283.html?live");
    await expectAnimatedCanvas(page, "/babylon-ref-scene283.html?live");
});
