/**
 * Scene 200 — High-Precision Matrix Jitter (HPM **off**) Parity Test
 *
 * Renders the shared HPM-jitter scene with `useHighPrecisionMatrix: false`
 * and asserts the captured frame matches the committed golden. The golden
 * locks in the F32-only baseline output at world coords ~1e6; any future
 * change that accidentally improves HPM-off precision (e.g. applying
 * floating-origin without the engine flag) will trip this test, surfacing
 * the regression of the explicit substrate boundary.
 *
 * MAD ceiling is intentionally permissive (5.0) because edge anti-aliasing
 * at this magnitude rounds differently across runs / GPUs while the
 * silhouette stays stable.
 *
 * Note: this scene has no Babylon.js reference page (HPM is a
 * Lite-specific substrate). `captureGolden` is intentionally not called —
 * the golden is captured once by running this spec with
 * `BABYLON_LITE_CAPTURE_HPM_GOLDEN=1`, committed, and treated as ground
 * truth thereafter.
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(200);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene200-high-precision-jitter-hpm-off");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 200 skipped via skipParity in scene-config.json");

test("Scene 200 — HPM Jitter (HPM off) matches committed golden", async ({ page }, testInfo) => {
    await page.goto("/scene200.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    // First-run capture: when the golden does not yet exist (or
    // BABYLON_LITE_CAPTURE_HPM_GOLDEN=1 is set), copy the actual to golden.
    // Subsequent runs assert against the committed bytes.
    if (!fs.existsSync(GOLDEN_REF) || process.env.BABYLON_LITE_CAPTURE_HPM_GOLDEN === "1") {
        fs.copyFileSync(screenshotPath, GOLDEN_REF);

        console.log(`Captured initial golden -> ${GOLDEN_REF}`);
    }

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 200 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `HPM-off full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
