/**
 * Scene 46 — Physics constraints parity test.
 *
 * Captures Babylon.js and Babylon Lite at fixed physics frame 10.
 */
import { test, expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(46);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene46-constraint-viewer");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const CAPTURE_FRAME = 10;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 46 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    if (fs.existsSync(GOLDEN_REF) && !process.env.RECAPTURE_GOLDEN) {
        return GOLDEN_REF;
    }

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene46.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 46 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: `Scene 46 BJS reference at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });

    await bjsPage.close();
    await context.close();
    return GOLDEN_REF;
}

test("Scene 46 — Physics constraints match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    const referencePath = await captureBjsReference(browser);

    await page.goto(`/scene46.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 46 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 46 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, referencePath);
    await attachCompareArtifacts(testInfo, screenshotPath, referencePath, REFERENCE_DIR);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
