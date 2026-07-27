/**
 * GL lab parity — config-driven.
 *
 * Iterates EVERY entry in scene-config-webgl.json and, for each scene that is
 * not flagged `skipParity`, compares the @babylonjs/lite-gl render against a
 * Babylon.js ThinEngine golden reference at a fixed, deterministic seek time.
 *
 * Adding scenes 2-6 later is mechanical: author lab/gl/babylon-ref-scene{N}.html
 * (+ its .ts) and flip `skipParity:false` in scene-config-webgl.json — this file
 * does NOT need to change.
 *
 * Determinism: both the lite scene and the BJS reference render exactly ONE
 * frame at uTime = SEEK_TIME (see the ?seekTime freeze convention in
 * lab/gl/src/_shared/run-effect.ts and lab/gl/src/babylon-ref-scene{N}.ts) and
 * stamp canvas.dataset.animationFrozen="true", so a screenshot of either is
 * directly comparable.
 */
import { test, expect } from "../../shared/reuse-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImageRects, compareImages, getSceneConfig, loadSceneConfigAll } from "./compare-utils";

/** Fixed freeze time used for every GL parity capture (lite + reference). */
const SEEK_TIME = 1.5;
const A2C_MAX_INTERIOR_CHANNEL_DIFF = 1;
const A2C_STABLE_INTERIOR_RECTS = [
    { x: 272, y: 172, width: 96, height: 96 },
    { x: 272, y: 452, width: 96, height: 96 },
    { x: 912, y: 172, width: 96, height: 96 },
    { x: 912, y: 452, width: 96, height: 96 },
] as const;

for (const entry of loadSceneConfigAll()) {
    const sceneConfig = getSceneConfig(entry.id);
    const referenceDir = path.resolve(__dirname, `../../../reference/gl/${sceneConfig.slug}`);
    const goldenRef = path.join(referenceDir, "babylon-ref-golden.png");

    test.describe(`GL Scene ${entry.id} — ${entry.name}`, () => {
        test.skip(!!sceneConfig.skipParity, `Scene ${entry.id} skipped via skipParity in scene-config-webgl.json`);

        test(`matches Babylon.js ThinEngine reference`, async ({ page }, testInfo) => {
            const browser = page.context().browser()!;

            // Capture (or reuse committed) golden from the BJS reference page at the freeze time.
            await captureGolden(browser, { sceneId: entry.id, seekTime: SEEK_TIME, timeout: 30_000, settleMs: 500 });

            // Render the lite-gl scene at the SAME frozen time.
            await page.goto(`/gl/scene${entry.id}.html?seekTime=${SEEK_TIME}`);
            await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
            await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
            if (entry.id === 17) {
                expect(await page.locator("canvas").getAttribute("data-sample-count")).toBe("4");
            }
            await page.waitForTimeout(300);

            const screenshotPath = path.join(referenceDir, "test-actual.png");
            await page.locator("canvas").screenshot({ path: screenshotPath });

            const full = compareImages(screenshotPath, goldenRef);
            const compared = entry.id === 17 ? compareImageRects(screenshotPath, goldenRef, A2C_STABLE_INTERIOR_RECTS) : full;
            await attachCompareArtifacts(testInfo, screenshotPath, goldenRef, referenceDir);
            const within1Pct = ((compared.within1 / compared.totalPixels) * 100).toFixed(2);
            console.log(
                `GL Scene ${entry.id} (${sceneConfig.slug}) — ${entry.id === 17 ? `full MAD=${full.mad.toFixed(4)} (informational) | stable interior MAD=${compared.mad.toFixed(4)} (informational) | maxDiff=${compared.maxDiff} (max ${A2C_MAX_INTERIOR_CHANNEL_DIFF})` : `MAD=${compared.mad.toFixed(4)} (max ${sceneConfig.maxMad}) | maxDiff=${compared.maxDiff}`} | within1=${within1Pct}% | ${compared.totalPixels}px`
            );

            if (entry.id === 17) {
                expect(compared.maxDiff, `Stable interior channel difference should be ≤ ${A2C_MAX_INTERIOR_CHANNEL_DIFF}`).toBeLessThanOrEqual(A2C_MAX_INTERIOR_CHANNEL_DIFF);
            } else {
                expect(compared.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
            }
        });
    });
}
