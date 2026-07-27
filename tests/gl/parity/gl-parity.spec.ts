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
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig, loadSceneConfigAll } from "./compare-utils";

/** Fixed freeze time used for every GL parity capture (lite + reference). */
const SEEK_TIME = 1.5;

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
            await attachCompareArtifacts(testInfo, screenshotPath, goldenRef, referenceDir);
            const within1Pct = ((full.within1 / full.totalPixels) * 100).toFixed(2);
            console.log(
                `GL Scene ${entry.id} (${sceneConfig.slug}) — MAD=${full.mad.toFixed(4)} (max ${sceneConfig.maxMad}) | maxDiff=${full.maxDiff} | within1=${within1Pct}% | ${full.totalPixels}px`
            );

            expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
        });
    });
}

test("GL Scene 16 restores its attribute binding after context loss", async ({ page }) => {
    const sceneConfig = getSceneConfig(16);
    const goldenRef = path.resolve(__dirname, `../../../reference/gl/${sceneConfig.slug}/babylon-ref-golden.png`);

    await page.goto("/gl/scene16.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(300);

    const extensionAvailable = await page.evaluate(async () => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const gl = canvas.getContext("webgl2")!;
        const ext = gl.getExtension("WEBGL_lose_context");
        if (!ext) {
            return false;
        }
        await new Promise<void>((resolve) => {
            canvas.addEventListener("webglcontextrestored", () => resolve(), { once: true });
            ext.loseContext();
            setTimeout(() => ext.restoreContext(), 0);
        });
        return true;
    });
    test.skip(!extensionAvailable, "WEBGL_lose_context is unavailable");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.contextRestored === "true", { timeout: 30_000 });
    await page.waitForTimeout(300);

    const screenshotPath = path.resolve(__dirname, `../../../reference/gl/${sceneConfig.slug}/test-actual.png`);
    await page.locator("canvas").screenshot({ path: screenshotPath });
    const full = compareImages(screenshotPath, goldenRef);
    expect(full.mad, "Scene 16 should match its golden after context restoration").toBeLessThanOrEqual(sceneConfig.maxMad);
});
