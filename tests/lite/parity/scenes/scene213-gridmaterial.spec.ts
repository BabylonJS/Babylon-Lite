/**
 * Scene 213 — GridMaterial Parity Test
 *
 * Compares Babylon Lite's `createGridMaterial` against a Babylon.js
 * `@babylonjs/materials` GridMaterial oracle rendering the same four meshes:
 * an opaque anti-aliased teal ground, a `useMaxLine` orange sphere, a
 * transparent alpha-blended cyan box (opacity 0.6), and a hard-cutoff
 * (antialias:false) pink box. Fully static — no seekTime.
 *
 * Golden is regenerated from the BJS reference page on every run (force:true)
 * because GridMaterial relies on screen-space derivatives (dpdx/dpdy) for line
 * anti-aliasing, which is subpixel-sensitive to the GPU/driver. Capturing the
 * BJS oracle on the same machine as the Lite render keeps the comparison
 * apples-to-apples across platforms (e.g. local Windows vs CI macOS).
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(213);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene213-gridmaterial");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 213 skipped via skipParity in scene-config.json");

test("Scene 213 — GridMaterial matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 213, force: true, settleMs: 500 });

    await page.goto("/scene213.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
