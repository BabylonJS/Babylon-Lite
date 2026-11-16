import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(315);
const referenceDir = path.resolve(__dirname, "../../../../reference/lite/scene315-mesh-blending-coastal-cliff");
const goldenRef = path.join(referenceDir, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 315 skipped via skipParity in scene-config.json");

test("Scene 315 — coastal-cliff mesh blending matches Babylon.js", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await captureGolden(page.context().browser()!, { sceneId: 315, timeout: 90_000, settleMs: 2_000 });
    await page.goto("/scene315.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 315 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });
    const actual = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, goldenRef);
    const region = compareRegion(actual, goldenRef, [6, 9, 11], 10);
    await attachCompareArtifacts(testInfo, actual, goldenRef, referenceDir);
    expect(result.mad).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
