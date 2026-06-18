/**
 * Scene 47 — Physics V2 heightfield parity test.
 *
 * Captures Babylon.js and Babylon Lite after a deterministic fixed-step
 * simulation in which two rows of shapes fall onto a heightfield derived from
 * heightMap.png, then compares the settled frame.
 */
import { test, expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(47);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene47-physics-heightfield");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const CAPTURE_FRAME = 1;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 47 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    if (fs.existsSync(GOLDEN_REF) && !process.env.RECAPTURE_GOLDEN) {
        return GOLDEN_REF;
    }

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene47.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 60_000, label: "Scene 47 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 60_000, label: `Scene 47 BJS reference at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });

    await bjsPage.close();
    await context.close();
    return GOLDEN_REF;
}

test("Scene 47 — Physics heightfield matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    const referencePath = await captureBjsReference(browser);

    await page.goto(`/scene47.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 60_000, label: "Scene 47 Lite" });
    await waitForCanvasReady(page, { timeout: 60_000, label: `Scene 47 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });

    // The Lite page includes /loader.js, whose #loader-overlay spinner fades out over 0.4s once
    // the scene is ready. Frame 1 capture fires before that fade completes, so the alpha-blended
    // overlay would otherwise be composited into the canvas screenshot. The engine is already
    // stopped (frame frozen), so wait for the overlay to be detached before capturing. This resolves
    // immediately if it is already gone, and surfaces a clear failure if it never dismisses rather
    // than silently screenshotting with the overlay still present.
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, referencePath);
    await attachCompareArtifacts(testInfo, screenshotPath, referencePath, REFERENCE_DIR);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
