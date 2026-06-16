/**
 * Scene 48 — Physics centre-of-mass parity test.
 *
 * Three tall boxes with distinct centres of mass drop, settle, then get a
 * horizontal force kick (via setTimeout). The frame is captured exactly 10
 * physics steps after the kick. The scene self-determines the capture frame,
 * so the spec just waits on the `captureReady` flag (no fixed ?captureFrame).
 */
import { test, expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(48);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene48-physics-center-of-mass");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 48 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    if (fs.existsSync(GOLDEN_REF) && !process.env.RECAPTURE_GOLDEN) {
        return GOLDEN_REF;
    }

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene48.html?capture=1`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 48 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 48 BJS reference after kick", flag: "captureReady", pollMs: 100 });
    await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });

    await bjsPage.close();
    await context.close();
    return GOLDEN_REF;
}

test("Scene 48 — Physics centre of mass matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    const referencePath = await captureBjsReference(browser);

    await page.goto(`/scene48.html?capture=1`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 48 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 48 Lite after kick", flag: "captureReady", pollMs: 100 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, referencePath);
    await attachCompareArtifacts(testInfo, screenshotPath, referencePath, REFERENCE_DIR);
    console.log(`Full image after kick (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
