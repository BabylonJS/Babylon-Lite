/**
 * Scene 101 — Physics V2 (Havok trigger volume) Parity Test
 *
 * Scene 101 ports playground #M0C2X5#1: a sphere drops from y=4, falls DOWN through a static
 * trigger sphere (TRIGGER_ENTERED), bounces off a perfectly elastic ground (restitution 1),
 * and rises back UP through the trigger (TRIGGER_EXITED). A red, alpha-0.7 sphere visualises
 * the trigger volume.
 *
 * The rendered frame is compared against a committed VISUAL golden (`babylon-ref-golden.png`)
 * captured from the Babylon.js reference page at the fixed capture frame. The trigger events
 * remain a live DATA comparison: the BJS reference page is launched each run to confirm that
 * BOTH TRIGGER_ENTERED and TRIGGER_EXITED fired by the capture frame, matching Lite.
 */
import { test, expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(101);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene101-physics-trigger");
const CAPTURE_FRAME = 150;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 101 skipped via skipParity in scene-config.json");

/** Launch the BJS reference page live to read the trigger-event DATA at the capture frame. */
async function captureBjsData(browser: Browser): Promise<{ entered: string | undefined; exited: string | undefined }> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene101.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 101 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: `Scene 101 BJS reference at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });

    const entered = await bjsPage.locator("canvas").evaluate((el) => (el as HTMLCanvasElement).dataset.entered);
    const exited = await bjsPage.locator("canvas").evaluate((el) => (el as HTMLCanvasElement).dataset.exited);

    await bjsPage.close();
    await context.close();
    return { entered, exited };
}

test("Scene 101 — Physics trigger volume matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    const goldenPath = await captureGolden(browser, { sceneId: 101, queryParams: `captureFrame=${CAPTURE_FRAME}`, waitFlag: "captureReady" });

    // Live DATA: both trigger events must have fired by the capture frame on the BJS reference.
    const bjs = await captureBjsData(browser);
    expect(bjs.entered, "BJS TRIGGER_ENTERED should have fired").toBe("true");
    expect(bjs.exited, "BJS TRIGGER_EXITED should have fired").toBe("true");

    await page.goto(`/scene101.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 101 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 101 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });

    // Core requirement: BOTH the enter and exit trigger events must have fired by the capture
    // frame (the ball entered on the way down and exited on the way up after bouncing).
    const entered = await page.locator("canvas").evaluate((el) => (el as HTMLCanvasElement).dataset.entered);
    const exited = await page.locator("canvas").evaluate((el) => (el as HTMLCanvasElement).dataset.exited);
    expect(entered, "TRIGGER_ENTERED should have fired and set dataset.entered").toBe("true");
    expect(exited, "TRIGGER_EXITED should have fired and set dataset.exited").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, goldenPath);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
