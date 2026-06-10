/**
 * Scene 219 — Per-instance VAT Parity Test
 *
 * Scene 219 renders the shark through Lite's PER-INSTANCE VAT path with a single identity-matrix thin-
 * instance. The instanced path computes finalWorld = instanceMatrix * mesh.world * skin, so an identity
 * instance equals the plain skinned pose — the golden is therefore the SAME live-skeleton shark as scene
 * 218 / scene 11, frozen at the integer frame seekTime*60. If the instanced VAT shader (per-instance frame
 * read from the instance texture by @builtin(instance_index), thin-instance world placement, dual-clip
 * blend with blend=0) is correct, it matches the live reference exactly.
 *
 * Assertions:
 * - Full image MAD ≤ scene-config maxMad
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(219);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene219-vat-instanced");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const SEEK_TIME = "1.0"; // integer frame (60) so the baked VAT row matches the BJS live pose exactly

test.skip(!!sceneConfig.skipParity, "Scene 219 skipped via skipParity in scene-config.json");

test("Scene 219 — per-instance VAT shark matches Babylon.js live-skeleton reference", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 219, seekTime: Number(SEEK_TIME), timeout: 180_000 });

    await page.goto(`/scene219.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
