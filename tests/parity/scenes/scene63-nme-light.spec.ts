/**
 * Scene 63 — NME Directional Light Parity Test
 *
 * Both BJS and Lite parse the SAME inline NME JSON and add one DirectionalLight
 * with identical direction. Sphere is lit via LightBlock.diffuseOutput on black.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(63);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene63-nme-light");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 63 skipped via skipParity in scene-config.json");

test("Scene 63 — NME directional light matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 63 });

    await page.goto("/scene63.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const region = compareRegion(screenshotPath, GOLDEN_REF);
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}; sphere region MAD=${region.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
