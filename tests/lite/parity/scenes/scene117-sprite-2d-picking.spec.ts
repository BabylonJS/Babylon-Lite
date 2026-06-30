/**
 * Scene 117 — 2D Sprite Picking Parity Test
 *
 * The scene resolves the centre sprite of a deterministic 5×3 HUD grid with `pickSprite2D`
 * and highlights it with a gold tint. The BJS oracle replicates the same highlight via
 * ThinSprite (Babylon has no 2D-sprite pick), so the pixels match while the `dataset` state
 * proves Lite's `pickSprite2D` resolved the correct sprite.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(117);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene117-sprite-2d-picking");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

async function readScene117State(page: Page) {
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 90_000 });
    return page.locator("canvas").evaluate((canvas) => {
        const data = (canvas as HTMLCanvasElement).dataset;
        return {
            pickedHit: data.pickedHit,
            expectedIndex: data.expectedIndex,
            pickedU: data.pickedU,
            pickedV: data.pickedV,
            highlightApplied: data.highlightApplied,
        };
    });
}

function expectScene117State(state: Awaited<ReturnType<typeof readScene117State>>): void {
    // pickSprite2D resolved the deterministic centre sprite, and the highlight was applied.
    expect(state.pickedHit).toBe(state.expectedIndex);
    expect(state.highlightApplied).toBe("true");
    // Picking the sprite centre yields the centre UV (pivot-aware), within float tolerance.
    expect(Number(state.pickedU)).toBeCloseTo(0.5, 2);
    expect(Number(state.pickedV)).toBeCloseTo(0.5, 2);
}

test("Scene 117 — 2D Sprite Picking matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(90_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 117, timeout: 90_000, settleMs: 1_000 });

    await page.goto("/scene117.html");
    expectScene117State(await readScene117State(page));
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
