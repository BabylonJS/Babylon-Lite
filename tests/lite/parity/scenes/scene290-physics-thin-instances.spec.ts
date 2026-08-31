import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(290);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene290-physics-thin-instances");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const CAPTURE_FRAME = 180;
const CAPTURE_QUERY = `captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 290 skipped via skipParity in scene-config.json");

test("Scene 290 — Havok thin instances match Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.goto(`/scene290.html?${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 120_000, label: "Scene 290 Lite" });
    await waitForCanvasReady(page, { timeout: 120_000, label: `Scene 290 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    expect(await page.locator("canvas").getAttribute("data-native-bodies")).toBe("2009");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });
    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
