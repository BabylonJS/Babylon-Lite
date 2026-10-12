import { expect, test } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, compareRegion, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(314);
const referenceDir = path.resolve(__dirname, "../../../../reference/lite/scene314-mesh-blending-cinematic-junctions");
const goldenRef = path.join(referenceDir, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 314 skipped via skipParity in scene-config.json");

test("Scene 314 — cinematic mesh blending junctions match Babylon.js", async ({ page }, testInfo) => {
    await captureGolden(page.context().browser()!, { sceneId: 314 });
    await page.goto("/scene314.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });
    const actual = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, goldenRef);
    const region = compareRegion(actual, goldenRef, [5, 6, 10], 10);
    await attachCompareArtifacts(testInfo, actual, goldenRef, referenceDir);
    expect(result.mad).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
