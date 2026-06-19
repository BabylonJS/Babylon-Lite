/**
 * Scene 100 — Physics V2 (Havok sphere drop + collision event) Parity Test
 *
 * Scene 100 is scene 40 plus a registered collision event (console.log + dataset flag).
 * The collision event is non-visual, so the captured frame is identical to scene 40.
 *
 * The rendered frame is compared against a committed VISUAL golden (`babylon-ref-golden.png`)
 * captured from the Babylon.js reference page at the fixed capture frame. The collision event
 * (`canvas.dataset.collided`) remains a live Lite-side assertion.
 *
 * BJS reference: playground #Z8HTUN#1 (+ collision event)
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(100);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene100-physics-collision");
const CAPTURE_FRAME = 120;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 100 skipped via skipParity in scene-config.json");

test("Scene 100 — Physics + collision event matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    const goldenPath = await captureGolden(browser, { sceneId: 100, queryParams: `captureFrame=${CAPTURE_FRAME}`, waitFlag: "captureReady" });

    await page.goto(`/scene100.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 100 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 100 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });

    // The collision event must have fired by the capture frame (sphere has hit the ground).
    const collided = await page.locator("canvas").evaluate((el) => (el as HTMLCanvasElement).dataset.collided);
    expect(collided, "collision event should have fired and set dataset.collided").toBe("true");

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, goldenPath);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
