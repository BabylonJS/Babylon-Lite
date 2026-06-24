/**
 * Scene 223 — Camera + Light Gizmos parity test.
 *
 * Pure display scene — both BJS and Lite render a CameraGizmo + LightGizmo
 * over a ground plane.  No scripted interaction; we just wait for the
 * scene to settle and compare the captured frame against the BJS reference.
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(223);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene223-camera-light-gizmos");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 223 skipped via skipParity in scene-config.json");

test("Scene 223 — Camera + Light Gizmos match Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const browser = page.context().browser()!;

    if (!fs.existsSync(GOLDEN_REF) || process.env.RECAPTURE_GOLDEN) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const bjsPage = await ctx.newPage();
        await bjsPage.goto("babylon-ref-scene223.html");
        await bjsPage.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
        await bjsPage.waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 }).catch(() => undefined);
        await bjsPage.waitForTimeout(500);
        fs.mkdirSync(REFERENCE_DIR, { recursive: true });
        await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });
        await bjsPage.close();
        await ctx.close();
    }

    await page.goto("scene223.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
