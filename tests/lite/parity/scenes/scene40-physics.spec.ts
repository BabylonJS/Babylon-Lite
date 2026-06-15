/**
 * Scene 40 — Physics V2 (Havok sphere drop) Parity Test
 *
 * Captures the Babylon.js and Babylon Lite physics scenes after 2 seconds of
 * live simulation and compares the frames.
 *
 * BJS reference: playground #Z8HTUN#1
 */
import { test, expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(40);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene40-physics");
const LIVE_REF = path.join(REFERENCE_DIR, "live-ref.png");
const CAPTURE_FRAME = 120;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 40 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene40.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 40 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: `Scene 40 BJS reference at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    await bjsPage.locator("canvas").screenshot({ path: LIVE_REF });

    await bjsPage.close();
    await context.close();
    return LIVE_REF;
}

test("Scene 40 — Physics matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    const referencePath = await captureBjsReference(browser);

    await page.goto(`/scene40.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 40 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 40 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, referencePath);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
