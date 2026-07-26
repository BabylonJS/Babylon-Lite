/**
 * Scene 268 — Orthographic Camera Projection.
 *
 * Two rows of identical boxes recede along +Z. A perspective projection would shrink the
 * far boxes and converge the rows; the orthographic projection keeps every box the same
 * on-screen size and the rows parallel, so any error in the ortho matrix (extent, aspect
 * derivation, or reverse-Z depth mapping) shows up immediately as a scale/offset diff.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(268);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene268-orthographic-camera");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 268 skipped via skipParity in scene-config.json");

test("Scene 268 — orthographic camera projection matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 268 });

    await page.goto("/scene268.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(100);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
