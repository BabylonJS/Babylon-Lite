// Right-handed twin of scene24-hillvalley.spec.ts: the same checks against the Babylon.js reference with useRightHandedSystem = true.
/**
 * Scene 343 — Hill Valley (.babylon) Parity Test
 *
 * Hill Valley town loaded from .babylon format with pre-baked lighting
 * (emissive-driven standard materials). Large scene: 114 meshes, 136 materials.
 *
 * Assertions:
 * - Full image MAD ≤ maxMad
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(343);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene343-rh-hillvalley");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 343 skipped via skipParity in scene-config.json");

test("Scene 343 — Hill Valley matches Babylon.js reference (right-handed)", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 343, force: true, timeout: 120_000 });

    await page.goto("/scene343.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 90_000 });
    await page.waitForTimeout(1000);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  Exact: ${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
