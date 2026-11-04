/**
 * Scene 231 — StandardMaterial deform features (per-vertex color + skeletal
 * skinning + UV offset) on an in-code beam with programmatically animated bones.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(231);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene231-standard-deform-features");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 231 skipped via skipParity in scene-config.json");

test("Scene 231 — StandardMaterial deform features match Babylon.js reference", async ({ page }, testInfo) => {
    await page.goto("/scene231.html?seekTime=0.5");
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
