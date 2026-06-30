/**
 * Scene 118 — Billboard Sprite Picking Parity Test
 *
 * The scene picks the centre camera-facing billboard via `pickBillboardSprite` and floats a
 * small marker mesh in front of it. The BJS oracle does the same with `scene.pickSprite`.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(118);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene118-billboard-picking");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

async function readScene118State(page: Page) {
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 90_000 });
    return page.locator("canvas").evaluate((canvas) => {
        const data = (canvas as HTMLCanvasElement).dataset;
        return {
            pickedHit: data.pickedHit,
            systemMatch: data.systemMatch,
            targetIndex: data.targetIndex,
            markerPlaced: data.markerPlaced,
            pickNearAnchor: data.pickNearAnchor,
            pickPoint: data.pickPoint,
        };
    });
}

function expectScene118State(state: Awaited<ReturnType<typeof readScene118State>>): void {
    // pickBillboardSprite resolved the centre billboard (the deterministic screen-centre target).
    expect(state.pickedHit).toBe(state.targetIndex);
    expect(state.systemMatch).toBe("true");
    expect(state.markerPlaced).toBe("true");
    expect(state.pickNearAnchor).toBe("true");
    const pickPoint = state.pickPoint?.split(",").map(Number) ?? [];
    expect(pickPoint).toHaveLength(3);
}

test("Scene 118 — Billboard Sprite Picking matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(90_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 118, timeout: 90_000, settleMs: 1_000 });

    await page.goto("/scene118.html");
    expectScene118State(await readScene118State(page));
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
