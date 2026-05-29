/**
 * Scene 201 — High-Precision Matrix Jitter (HPM **on**) Parity Test
 *
 * Renders the shared HPM-jitter scene with `useHighPrecisionMatrix: true`
 * and asserts the captured frame matches the committed golden. The CPU
 * view-projection chain is F64-backed; only the final GPU upload performs
 * the F32 downcast via `packMat4IntoF32`. The golden is the stable
 * reference that future M1 work (floating-origin) is expected to further
 * tighten.
 *
 * MAD ceiling is tight (0.5) because the HPM-on path is supposed to
 * produce the same bytes deterministically across runs — any drift here
 * indicates a regression in the F64 substrate.
 *
 * Note: this scene has no Babylon.js reference page (HPM is a
 * Lite-specific substrate). See the sibling scene200 spec for the
 * one-shot capture convention.
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(201);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene201-high-precision-jitter-hpm-on");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 201 skipped via skipParity in scene-config.json");

test("Scene 201 — HPM Jitter (HPM on) matches committed golden", async ({ page }, testInfo) => {
    await page.goto("/scene201.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    // Validate the engine actually enabled HPM — guards against silent
    // regression of the engine option plumbing.
    const useHpm = await page.evaluate(() => document.querySelector("canvas")?.dataset.useHighPrecisionMatrix);
    expect(useHpm, "Scene 201 must report useHighPrecisionMatrix=true on the canvas dataset").toBe("true");

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    if (!fs.existsSync(GOLDEN_REF) || process.env.BABYLON_LITE_CAPTURE_HPM_GOLDEN === "1") {
        fs.copyFileSync(screenshotPath, GOLDEN_REF);

        console.log(`Captured initial golden -> ${GOLDEN_REF}`);
    }

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 201 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `HPM-on full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
