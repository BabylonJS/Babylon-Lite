/**
 * Scene 44 — Physics sleeping towers parity test.
 *
 * Drops small boxes after 2 seconds and captures Babylon.js / Babylon Lite at 5 seconds.
 */
import { test, expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(44);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene44-physics-sleeping-towers");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const CAPTURE_AFTER_SECONDS = 5;
const CAPTURE_QUERY = `?captureAfter=${CAPTURE_AFTER_SECONDS}`;

test.skip(!!sceneConfig.skipParity, "Scene 44 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    if (fs.existsSync(GOLDEN_REF) && !process.env.RECAPTURE_GOLDEN) {
        return GOLDEN_REF;
    }

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`babylon-ref-scene44.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 44 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: `Scene 44 BJS reference after ${CAPTURE_AFTER_SECONDS}s`, flag: "captureReady", pollMs: 100 });
    await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });

    await bjsPage.close();
    await context.close();
    return GOLDEN_REF;
}

test("Scene 44 — Physics sleeping towers matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    const referencePath = await captureBjsReference(browser);

    await page.goto(`scene44.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 44 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 44 Lite after ${CAPTURE_AFTER_SECONDS}s`, flag: "captureReady", pollMs: 100 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, referencePath);
    await attachCompareArtifacts(testInfo, screenshotPath, referencePath, REFERENCE_DIR);
    console.log(`Full image after ${CAPTURE_AFTER_SECONDS}s (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
