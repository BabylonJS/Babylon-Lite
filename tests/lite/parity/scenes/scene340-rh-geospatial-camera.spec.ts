// Right-handed twin of scene225-geospatial-camera.spec.ts: the same checks against the Babylon.js reference with useRightHandedSystem = true.
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(340);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene340-rh-geospatial-camera");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 340 skipped via skipParity in scene-config.json");

test("Scene 340 - Geospatial camera matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    // Regenerate the BJS GeospatialCamera oracle on the same machine so the view matrix matches exactly.
    await captureGolden(browser, { sceneId: 340, force: true });

    await page.goto("/scene340.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
