// Right-handed twin of scene149-node-geometry-renderer.spec.ts: the same checks against the Babylon.js reference with useRightHandedSystem = true.
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(346);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene346-rh-node-geometry-renderer");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 346 skipped via skipParity in scene-config.json");

test("Scene 346 — node-material geometry renderer task matches Babylon.js reference (right-handed)", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 346, force: true, timeout: 120_000, settleMs: 5_000 });

    await page.goto("/scene346.html");
    await waitForCanvasReady(page, { timeout: 120_000, label: "Scene 346 Lite" });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
