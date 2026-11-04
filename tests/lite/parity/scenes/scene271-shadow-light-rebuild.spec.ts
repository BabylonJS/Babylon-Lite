/**
 * Scene 271 — Shadow Light Rebuild Parity Test
 *
 * The Lite scene builds with spot light A, renders, then removes it, adds spot light B (opposite
 * side, its own PCF generator) and re-registers — which rebuilds the baked light/shadow state.
 * The Babylon.js reference renders the final light-B configuration directly, so a correct rebuild
 * must produce the same image.
 *
 * Assertions:
 * - Full image MAD ≤ scene-config threshold
 * - ≥99% of pixels within 5 bytes
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(271);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene271-shadow-light-rebuild");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 271 skipped via skipParity in scene-config.json");

test("Scene 271 — Shadow Light Rebuild matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 271 });

    const gpuErrors: string[] = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            gpuErrors.push(msg.text());
        }
    });
    page.on("pageerror", (err) => gpuErrors.push(err.message));

    await page.goto("/scene271.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(1000);

    // Surfaces whether the topology rebuild applied on the machine under test — a pixel diff alone cannot
    // distinguish "rebuild did not run" from "rebuild ran but shaded slightly differently".
    const rebuildState = await page.evaluate(() => document.querySelector("canvas")?.dataset.rebuild);
    console.log(`Rebuild state: ${rebuildState}`);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px):`);
    console.log(`  MAD: ${full.mad.toFixed(3)}`);
    console.log(`  ≤5: ${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    // Swapping a shadow-casting light must not leave a destroyed/dangling GPU resource bound.
    expect(
        gpuErrors.filter((e) => /destroyed|used in a submit|validation/i.test(e)),
        "no WebGPU validation errors"
    ).toEqual([]);
    expect(rebuildState, "the topology rebuild applied").toMatch(/^applied/);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    expect(full.within5 / full.totalPixels, "≥99% within 5 bytes").toBeGreaterThanOrEqual(0.99);
});
