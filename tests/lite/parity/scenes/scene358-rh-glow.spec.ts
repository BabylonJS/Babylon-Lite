// Right-handed twin of scene356-glow.spec.ts: the same checks against the Babylon.js reference with useRightHandedSystem = true.
/**
 * Scene 358 — Selective Glow Parity Test (right-handed)
 *
 * Protects glow-map pipeline winding for Standard, PBR and NodeMaterial surfaces in right-handed builds.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(358);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene358-rh-glow");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 358 skipped via skipParity in scene-config.json");

test("Scene 358 — selective glow matches Babylon.js GlowLayer (right-handed)", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 358 });

    await page.goto("/scene358.html");
    await waitForCanvasReady(page, { timeout: 60_000, label: "Scene 358 Lite" });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
