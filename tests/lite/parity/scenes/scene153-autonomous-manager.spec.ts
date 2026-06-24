import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(153);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene153-autonomous-manager");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const SEEK_TIME = 1;

test.skip(!!sceneConfig.skipParity, "Scene 153 skipped via skipParity in scene-config.json");

test("Scene 153 - autonomous AnimationManager runs without a Lite scene", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 153, seekTime: SEEK_TIME, timeout: 60_000, settleMs: 100 });

    await page.goto(`scene153.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 60_000 });
    await page.waitForTimeout(100);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});

test("Scene 153 - autonomous AnimationManager advances on its own RAF loop", async ({ page }) => {
    await page.goto("scene153.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });

    const first = await page.locator("canvas").evaluate((canvas) => Number((canvas as HTMLCanvasElement).dataset.animatedX));
    await page.waitForTimeout(700);
    const second = await page.locator("canvas").evaluate((canvas) => Number((canvas as HTMLCanvasElement).dataset.animatedX));

    expect(Math.abs(second - first)).toBeGreaterThan(0.25);
});

test("Scene 153 - Babylon.js reference advances automatically", async ({ page }) => {
    await page.goto("babylon-ref-scene153.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });

    const first = await page.locator("canvas").evaluate((canvas) => Number((canvas as HTMLCanvasElement).dataset.animatedX));
    await page.waitForTimeout(700);
    const second = await page.locator("canvas").evaluate((canvas) => Number((canvas as HTMLCanvasElement).dataset.animatedX));

    expect(Math.abs(second - first)).toBeGreaterThan(0.25);
});
