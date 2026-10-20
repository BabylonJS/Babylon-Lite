/**
 * Scene 331 — scene 122's SOG + SH after 300 full-resolution point-sampling frames.
 * The provisional golden is the classic BJS fallback until PR #18962 reaches npm.
 * Recapture it explicitly after upgrading BJS; never regenerate it during this test.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(331);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene331-gs-point-splatting");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 331 skipped via skipParity in scene-config.json");

test("Scene 331 — converged Gaussian point sampling matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    await page.goto("/scene331.html");
    await waitForCanvasReady(page, { timeout: 300_000, label: "Scene 331 Lite (300 point-sampling frames)" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const canvas = page.locator("canvas");
    expect(Number(await canvas.getAttribute("data-rendered-frame-count"))).toBeGreaterThanOrEqual(300);
    await expect(canvas).toHaveAttribute("data-pixel-cycle-length", "1");
    await expect(canvas).toHaveAttribute("data-render-mode", "point");
    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await canvas.screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
