/**
 * Scene 67 — NME PBR Metallic-Roughness Core Parity Test
 *
 * Same NME JSON parsed by both BJS and Lite. The PBRMetallicRoughnessBlock
 * uses ReflectionBlock/IBL plus direct lights on a saturated matte base.
 * This is the foundation scene for the scene67-72 PBR-NME phase.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(67);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene67-nme-pbr-core");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 67 skipped via skipParity in scene-config.json");

test("Scene 67 — NME PBR core matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 67 });

    await page.goto("/scene67.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
