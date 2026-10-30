// Right-handed twin of scene54-facing-billboards.spec.ts: the same checks against the Babylon.js reference with useRightHandedSystem = true.
/**
 * Scene 337 - Facing Billboards Parity Test.
 *
 * Compares Babylon Lite's world-space camera-facing billboard sprite system
 * against Babylon.js SpriteManager using the same atlas, world positions,
 * sizes, colors, rotations, and depth-tested transparent composition.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(337);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene337-rh-facing-billboards");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 337 skipped via skipParity in scene-config.json");

test("Scene 337 - Facing billboards match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 337, force: true, settleMs: 500 });

    await page.goto("/scene337.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
