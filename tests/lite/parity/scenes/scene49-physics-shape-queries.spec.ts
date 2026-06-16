/**
 * Scene 49 — Physics shape-query parity test.
 *
 * A cylinder query shape and a capsule body: shapeProximity draws the closest-point
 * pair (orange on the cylinder, red on the capsule), while shapeCast sweeps the
 * cylinder +X and draws the cast ray (cyan) plus its hit point on the capsule (green).
 * The static scene self-determines its capture frame (once the broadphase exists and
 * both queries report hits), so the spec just waits on the `captureReady` flag.
 */
import { test, expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(49);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene49-physics-shape-queries");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 49 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    if (fs.existsSync(GOLDEN_REF) && !process.env.RECAPTURE_GOLDEN) {
        return GOLDEN_REF;
    }

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();

    await bjsPage.goto(`/babylon-ref-scene49.html?capture=1`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 49 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 49 BJS reference queries", flag: "captureReady", pollMs: 100 });
    await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });

    await bjsPage.close();
    await context.close();
    return GOLDEN_REF;
}

test("Scene 49 — Physics shape queries match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    const referencePath = await captureBjsReference(browser);

    await page.goto(`/scene49.html?capture=1`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 49 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 49 Lite queries", flag: "captureReady", pollMs: 100 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, referencePath);
    await attachCompareArtifacts(testInfo, screenshotPath, referencePath, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
