/**
 * Scene 102 — Physics V2 (Havok raycast + collision filtering) Parity Test
 *
 * Port of playground #PY59V9#7. Two static MESH boxes (filter membership 1 and 2), a ground,
 * and a ray. A filtered raycast (collideWith=2) is run; its result (hasHit, hitPoint,
 * hitDistance, triangleIndex) is logged and written to canvas.dataset.rayResult.
 *
 * The rendered frame is compared against a committed VISUAL golden (`babylon-ref-golden.png`)
 * captured from the Babylon.js reference page at the fixed capture frame. The raycast VALUES
 * remain a live DATA comparison: the BJS reference page is launched each run and its raycast
 * result is asserted equal to Lite's.
 */
import { test, expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(102);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene102-physics-raycast");
const CAPTURE_FRAME = 5;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 102 skipped via skipParity in scene-config.json");

async function readRayResult(page: Page): Promise<string | undefined> {
    return page.locator("canvas").evaluate((el) => (el as HTMLCanvasElement).dataset.rayResult);
}

/** Launch the BJS reference page live to read the raycast result DATA at the capture frame. */
async function captureBjsData(browser: Browser): Promise<string | undefined> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene102.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 102 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: `Scene 102 BJS reference at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    const rayResult = await readRayResult(bjsPage);

    await bjsPage.close();
    await context.close();
    return rayResult;
}

test("Scene 102 — Physics raycast filtering matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    const goldenPath = await captureGolden(browser, { sceneId: 102, queryParams: `captureFrame=${CAPTURE_FRAME}`, waitFlag: "captureReady" });
    const bjsRayResult = await captureBjsData(browser);

    await page.goto(`/scene102.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 102 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 102 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    const liteRayResult = await readRayResult(page);

    // The raycast result values must be identical between Lite and Babylon.js.
    console.log(`Scene 102 raycast — BJS: ${bjsRayResult}`);
    console.log(`Scene 102 raycast — Lite: ${liteRayResult}`);
    expect(liteRayResult, "Lite raycast result should be present").toBeTruthy();
    expect(bjsRayResult, "BJS raycast result should be present").toBeTruthy();
    const lite = JSON.parse(liteRayResult!);
    const bjs = JSON.parse(bjsRayResult!);
    expect(lite.hasHit, "hasHit should match").toBe(bjs.hasHit);
    expect(lite.hasHit, "raycast should hit box2 (collideWith=2)").toBe(true);
    expect(lite.triangleIndex, "triangleIndex should match").toBe(bjs.triangleIndex);
    expect(Math.abs(lite.hitDistance - bjs.hitDistance), "hitDistance should match").toBeLessThanOrEqual(0.01);
    expect(Math.abs(lite.hitPoint.x - bjs.hitPoint.x), "hitPoint.x should match").toBeLessThanOrEqual(0.01);
    expect(Math.abs(lite.hitPoint.y - bjs.hitPoint.y), "hitPoint.y should match").toBeLessThanOrEqual(0.01);
    expect(Math.abs(lite.hitPoint.z - bjs.hitPoint.z), "hitPoint.z should match").toBeLessThanOrEqual(0.01);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, goldenPath);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
