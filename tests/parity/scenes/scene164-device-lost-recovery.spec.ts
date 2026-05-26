import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(164);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene164-device-lost-recovery");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 164 skipped via skipParity in scene-config.json");

test("Scene 164 — device-lost recovery restores Alien rendering", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 164, seekTime: 2, force: true, timeout: 60_000, settleMs: 500 });

    await page.goto("/scene164.html?seekTime=2");

    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.deviceLost === "true", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.deviceRecovered === "true", { timeout: 30_000 });
    await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.postRecoveryFrames ?? "0") >= 10, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(200);

    const renderable = await page.locator("canvas").evaluate((canvas) => {
        const c = canvas as HTMLCanvasElement;
        return c.width > 0 && c.height > 0;
    });
    expect(renderable).toBe(true);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    expect(region.mad, `Alien MAD should be ≤ ${sceneConfig.maxRegionMad}`).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
