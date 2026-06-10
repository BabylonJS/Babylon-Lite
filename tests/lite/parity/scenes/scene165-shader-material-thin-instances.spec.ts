/**
 * Scene 165 — ShaderMaterial Thin Instances Parity Tests
 *
 * Custom WGSL ShaderMaterial rendered with thin instances + per-instance color
 * (8×8×8 grid of unit cubes, deterministic color ramp), compared against the
 * Babylon.js WGSL ShaderMaterial oracle golden.
 *
 * Two tests share one golden, captured once with `force: true` so CI regenerates
 * the BJS oracle on the SAME (cloud) machine — a locally-committed golden causes
 * cross-platform MAD failures on the cloud browser. The tests run serially (same
 * file) so the shared golden is never written concurrently.
 *
 * Test 1 — thin instances: /scene165.html vs golden.
 * Test 2 — GPU culling: /scene165.html?culling vs the SAME golden (culling only
 *   removes off-screen instances, so the visible image must be identical).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(165);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene165-shader-material-thin-instances");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.describe.serial("Scene 165 — ShaderMaterial thin instances", () => {
    test.skip(!!sceneConfig.skipParity, "Scene 165 skipped via skipParity in scene-config.json");

    test.beforeAll(async ({ browser }) => {
        // force:true → regenerate the BJS oracle golden on this machine (cloud-safe).
        await captureGolden(browser, { sceneId: 165, force: true });
    });

    test("thin instances matches Babylon.js reference", async ({ page }, testInfo) => {
        await page.goto("/scene165.html");
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
        await page.waitForTimeout(1000);

        const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
        await page.locator("canvas").screenshot({ path: screenshotPath });

        const full = compareImages(screenshotPath, GOLDEN_REF);
        await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
        console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, exact=${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);

        expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
        expect(full.exactMatch / full.totalPixels, "≥95% exact match").toBeGreaterThanOrEqual(0.95);
    });

    test("GPU culling renders identically to non-culled golden", async ({ page }, testInfo) => {
        await page.goto("/scene165.html?culling");
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
        await page.waitForTimeout(1000);

        const gpuCulling = await page.evaluate(() => document.querySelector("canvas")?.dataset.gpuCulling);
        expect(gpuCulling, "GPU culling must be active").toBe("thin-instances");

        const screenshotPath = path.join(REFERENCE_DIR, "test-actual-culling.png");
        await page.locator("canvas").screenshot({ path: screenshotPath });

        const full = compareImages(screenshotPath, GOLDEN_REF);
        await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
        console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, exact=${((100 * full.exactMatch) / full.totalPixels).toFixed(1)}%`);

        expect(full.mad, `Culled image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
        expect(full.exactMatch / full.totalPixels, "≥95% exact match vs non-culled golden").toBeGreaterThanOrEqual(0.95);
    });
});
