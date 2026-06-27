import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(215);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene215-cascaded-shadows-pbr");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 215 skipped via skipParity in scene-config.json");

test("Scene 215 - Cascaded shadow maps on PBR receivers match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    // Regenerate the BJS CSM oracle on the same machine so cascade fits match exactly.
    await captureGolden(browser, { sceneId: 215, force: true });

    await page.goto("scene215.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
