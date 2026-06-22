/**
 * Scene 246 — SimpleSkin (cx20 gltf-test parity).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(246);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene246-simple-skin");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 246 skipped via skipParity in scene-config.json");

test("Scene 246 — SimpleSkin matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 246, seekTime: 1, timeout: 90_000 });

    await page.goto("/scene246.html?seekTime=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
