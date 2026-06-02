import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(152);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene152-gltf-manager");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const SEEK_TIME = 1.91;

test.skip(!!sceneConfig.skipParity, "Scene 152 skipped via skipParity in scene-config.json");

test("Scene 152 — unified AnimationManager drives glTF and manual groups", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 152, seekTime: SEEK_TIME, timeout: 120_000 });

    await page.goto(`/scene152.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});

test("Scene 152 — Babylon.js reference advances glTF and camera animations live", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/babylon-ref-scene152.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });

    const first = await page.locator("canvas").evaluate((canvas) => ({
        alpha: Number((canvas as HTMLCanvasElement).dataset.cameraAlpha),
        frame: Number((canvas as HTMLCanvasElement).dataset.swimFrame),
    }));
    await page.waitForTimeout(700);
    const second = await page.locator("canvas").evaluate((canvas) => ({
        alpha: Number((canvas as HTMLCanvasElement).dataset.cameraAlpha),
        frame: Number((canvas as HTMLCanvasElement).dataset.swimFrame),
    }));

    expect(Math.abs(second.alpha - first.alpha)).toBeGreaterThan(0.1);
    expect(Math.abs(second.frame - first.frame)).toBeGreaterThan(1);
});
