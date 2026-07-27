import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImageRects, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(268);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene268-alpha-to-coverage");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const MAX_INTERIOR_CHANNEL_DIFF = 1;
const STABLE_INTERIOR_RECTS = [
    { x: 272, y: 172, width: 96, height: 96 },
    { x: 272, y: 452, width: 96, height: 96 },
    { x: 912, y: 172, width: 96, height: 96 },
    { x: 912, y: 452, width: 96, height: 96 },
] as const;

test.skip(!!sceneConfig.skipParity, "Scene 268 skipped via skipParity in scene-config.json");

test("Scene 268 — alpha-to-coverage matches Babylon.js WebGPU", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 268, timeout: 60_000 });

    await page.goto("/scene268.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    expect(await page.locator("canvas").getAttribute("data-sample-count")).toBe("4");
    await page.waitForTimeout(200);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    const interior = compareImageRects(screenshotPath, GOLDEN_REF, STABLE_INTERIOR_RECTS);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(
        `Alpha-to-coverage full image MAD: ${full.mad.toFixed(3)} (informational); stable interior MAD: ${interior.mad.toFixed(3)} (informational); maxDiff: ${interior.maxDiff} (limit ${MAX_INTERIOR_CHANNEL_DIFF})`
    );
    expect(interior.maxDiff, `Stable interior channel difference should be <= ${MAX_INTERIOR_CHANNEL_DIFF}`).toBeLessThanOrEqual(MAX_INTERIOR_CHANNEL_DIFF);
});
