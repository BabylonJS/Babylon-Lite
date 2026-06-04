/**
 * Scene 113 — Picking Precision Parity Test
 *
 * The scene performs one detailed pick on a sphere and uses the picked point and
 * normal to place visible surface/normal markers.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(113);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene113-picking-precision");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

async function readScene113State(page: Page) {
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 90_000 });
    return page.locator("canvas").evaluate((canvas) => {
        const data = (canvas as HTMLCanvasElement).dataset;
        return {
            pickedHit: data.pickedHit,
            markerPlaced: data.markerPlaced,
            normalMarkerPlaced: data.normalMarkerPlaced,
            normalMarkerAligned: data.normalMarkerAligned,
            markerNearPick: data.markerNearPick,
            normalMarkerNearPick: data.normalMarkerNearPick,
            pickPoint: data.pickPoint,
        };
    });
}

function parseVec3(value: string | undefined): [number, number, number] {
    const parts = value?.split(",").map(Number) ?? [];
    expect(parts).toHaveLength(3);
    return [parts[0]!, parts[1]!, parts[2]!];
}

function expectScene113State(hitState: Awaited<ReturnType<typeof readScene113State>>): void {
    expect(hitState.pickedHit).toBe("scene113-picked-sphere");
    expect(hitState.markerPlaced).toBe("true");
    expect(hitState.normalMarkerPlaced).toBe("true");
    expect(hitState.normalMarkerAligned).toBe("true");
    expect(hitState.markerNearPick).toBe("true");
    expect(hitState.normalMarkerNearPick).toBe("true");
    const pickPoint = parseVec3(hitState.pickPoint);
    expect(Math.abs(pickPoint[0]), "Scene 113 should use the off-center visual pick target").toBeGreaterThan(0.5);
    expect(Math.abs(pickPoint[1]), "Scene 113 should use the off-center visual pick target").toBeGreaterThan(0.1);
}

test("Scene 113 — Picking Precision matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(90_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 113, timeout: 90_000, settleMs: 1_000 });

    await page.goto("/scene113.html");
    expectScene113State(await readScene113State(page));
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
