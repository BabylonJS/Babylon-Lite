/**
 * Scene 103 — Physics V2 (thin-instanced wall + raycast instance picking) Parity Test
 *
 * Port of playground #I6AR8X. A 10×6×3 wall of thin-instanced cylinders. STATIC (mass 0) per-instance
 * BOX bodies resolve WHICH instance a camera-relative raycast hits. A fixed set of deterministic rays
 * is fired; each ray's hit instance index is written to canvas.dataset.rayHits.
 *
 * The rendered frame is compared against a committed VISUAL golden (`babylon-ref-golden.png`)
 * captured from the Babylon.js reference page at the fixed capture frame. The per-ray hit instance
 * indices remain a live DATA comparison: the BJS reference page is launched each run and every ray's
 * `hasHit` + hit instance index is asserted IDENTICAL to Lite's.
 */
import { test, expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(103);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene103-thin-instance-raycast");
const CAPTURE_FRAME = 5;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

interface RayHit {
    hasHit: boolean;
    instance: number;
    point: { x: number; y: number; z: number };
}

test.skip(!!sceneConfig.skipParity, "Scene 103 skipped via skipParity in scene-config.json");

async function readRayHits(page: Page): Promise<string | undefined> {
    return page.locator("canvas").evaluate((el) => (el as HTMLCanvasElement).dataset.rayHits);
}

/** Launch the BJS reference page live to read the raycast-hit DATA at the capture frame. */
async function captureBjsData(browser: Browser): Promise<string | undefined> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene103.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 103 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: `Scene 103 BJS reference at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    const rayHits = await readRayHits(bjsPage);

    await bjsPage.close();
    await context.close();
    return rayHits;
}

test("Scene 103 — Thin-instance raycast picking matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    const goldenPath = await captureGolden(browser, { sceneId: 103, queryParams: `captureFrame=${CAPTURE_FRAME}`, waitFlag: "captureReady" });
    const bjsRayHits = await captureBjsData(browser);

    await page.goto(`/scene103.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 103 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 103 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    const liteRayHits = await readRayHits(page);

    console.log(`Scene 103 rayHits — BJS:  ${bjsRayHits}`);
    console.log(`Scene 103 rayHits — Lite: ${liteRayHits}`);
    expect(liteRayHits, "Lite rayHits should be present").toBeTruthy();
    expect(bjsRayHits, "BJS rayHits should be present").toBeTruthy();
    const lite = JSON.parse(liteRayHits!) as RayHit[];
    const bjs = JSON.parse(bjsRayHits!) as RayHit[];

    expect(lite.length, "ray count should match").toBe(bjs.length);
    expect(lite.length).toBeGreaterThanOrEqual(5);
    // Every ray must hit the SAME instance index in both engines.
    for (let r = 0; r < bjs.length; r++) {
        expect(lite[r]!.hasHit, `ray ${r} hasHit should match`).toBe(bjs[r]!.hasHit);
        expect(bjs[r]!.hasHit, `ray ${r} should hit some instance`).toBe(true);
        expect(lite[r]!.instance, `ray ${r} hit instance index should match (BJS=${bjs[r]!.instance}, Lite=${lite[r]!.instance})`).toBe(bjs[r]!.instance);
    }

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, goldenPath);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
