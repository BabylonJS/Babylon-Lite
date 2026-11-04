import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(169);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene169-compute-flame");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const SEEK_TIME = 1.25;

test.skip(!!sceneConfig.skipParity, "Scene 169 skipped via skipParity in scene-config.json");

test("Scene 169 — depth-aware compute flame matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 169, seekTime: SEEK_TIME, timeout: 120_000, settleMs: 500 });

    await page.goto(`/scene169.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});

test("Scene 169 — animate query keeps the compute flame live", async ({ page }) => {
    await page.goto(`/scene169.html?animate&seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await expect(page.locator("canvas")).toHaveAttribute("data-flame-animated", "true");

    const first = await page.locator("canvas").screenshot();
    await page.waitForTimeout(500);
    const second = await page.locator("canvas").screenshot();

    expect(first.equals(second)).toBe(false);
});
