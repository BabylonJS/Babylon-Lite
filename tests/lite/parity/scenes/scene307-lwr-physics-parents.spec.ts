import { test, expect, acquireReferencePage } from "../parity-fixtures";
import type { Browser } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(307);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene307-lwr-physics-parents");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const CAPTURE_FRAME = 100;
const CAPTURE_QUERY = `?captureFrame=${CAPTURE_FRAME}`;

test.skip(!!sceneConfig.skipParity, "Scene 307 skipped via skipParity in scene-config.json");

async function captureBjsReference(browser: Browser): Promise<string> {
    if (fs.existsSync(GOLDEN_REF) && !process.env.RECAPTURE_GOLDEN) {
        return GOLDEN_REF;
    }

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const { page: bjsPage, release } = await acquireReferencePage(browser);

    await bjsPage.goto(`/babylon-ref-scene307.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: "Scene 307 BJS reference" });
    await waitForCanvasReady(bjsPage, { timeout: 50_000, label: `Scene 307 BJS reference at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });
    await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });

    await release();
    return GOLDEN_REF;
}

test("Scene 307 — LWR Physics Parents", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    const referencePath = await captureBjsReference(browser);

    await page.goto(`/scene307.html${CAPTURE_QUERY}`);
    await waitForCanvasReady(page, { timeout: 50_000, label: "Scene 307 Lite" });
    await waitForCanvasReady(page, { timeout: 50_000, label: `Scene 307 Lite at frame ${CAPTURE_FRAME}`, flag: "captureReady", pollMs: 100 });

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, referencePath);
    await attachCompareArtifacts(testInfo, screenshotPath, referencePath, REFERENCE_DIR);
    console.log(`Full image at frame ${CAPTURE_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
