import { expect, test, acquireReferencePage } from "../parity-fixtures";
import type { Browser } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, compareImages, compareRegion, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(311);
const referenceDir = path.resolve(__dirname, "../../../../reference/lite/scene311-mesh-blending-shadow-attenuation");
const liveReference = path.join(referenceDir, "live-ref.png");

test.skip(!!sceneConfig.skipParity, "Scene 311 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    const { page, release } = await acquireReferencePage(browser);
    try {
        await page.goto("/babylon-ref-scene311.html");
        await waitForCanvasReady(page, { timeout: 30_000, label: "Scene 311 BJS reference" });
        await page.locator("canvas").screenshot({ path: liveReference });
        return liveReference;
    } finally {
        await release();
    }
}

test("Scene 311 — mesh blending shadow attenuation matches Babylon.js", async ({ page }, testInfo) => {
    const reference = await captureBjsReference(page.context().browser()!);
    await page.goto("/scene311.html");
    await waitForCanvasReady(page, { timeout: 30_000, label: "Scene 311 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });
    const actual = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, reference);
    const region = compareRegion(actual, reference, [10, 10, 10], 10);
    await attachCompareArtifacts(testInfo, actual, reference, referenceDir);
    expect(result.mad).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(region.mad).toBeLessThanOrEqual(sceneConfig.maxRegionMad!);
});
