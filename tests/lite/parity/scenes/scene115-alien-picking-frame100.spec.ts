/**
 * Scene 115 - Alien Picking at Frame 100
 *
 * Both the Babylon.js reference and Babylon Lite freeze the animated Alien at
 * frame 100 (seekTime = 100 / 60), perform the same precise pick at the same
 * CSS canvas coordinate, and move visible markers from the real pick data.
 */
import { test, expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const SCENE_ID = 115;
const SEEK_TIME = 100 / 60;
const sceneConfig = getSceneConfig(SCENE_ID);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene115-alien-picking-frame100");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

interface PickState {
    pickedHit: string | undefined;
    pickCss: string | undefined;
    pickPoint: string | undefined;
    pickNormal: string | undefined;
    pickFaceId: string | undefined;
    pickSubMeshFaceId: string | undefined;
    pickSubMeshId: string | undefined;
    pickBu: string | undefined;
    pickBv: string | undefined;
    pickDistance: string | undefined;
    markerPlaced: string | undefined;
    normalMarkerPlaced: string | undefined;
    normalMarkerAligned: string | undefined;
    markerNearPick: string | undefined;
    normalMarkerNearPick: string | undefined;
    seekFrame: string | undefined;
}

async function readPickState(page: Page): Promise<PickState> {
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 90_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 90_000 });
    return page.locator("canvas").evaluate((canvas) => {
        const data = (canvas as HTMLCanvasElement).dataset;
        return {
            pickedHit: data.pickedHit,
            pickCss: data.pickCss,
            pickPoint: data.pickPoint,
            pickNormal: data.pickNormal,
            pickFaceId: data.pickFaceId,
            pickSubMeshFaceId: data.pickSubMeshFaceId,
            pickSubMeshId: data.pickSubMeshId,
            pickBu: data.pickBu,
            pickBv: data.pickBv,
            pickDistance: data.pickDistance,
            markerPlaced: data.markerPlaced,
            normalMarkerPlaced: data.normalMarkerPlaced,
            normalMarkerAligned: data.normalMarkerAligned,
            markerNearPick: data.markerNearPick,
            normalMarkerNearPick: data.normalMarkerNearPick,
            seekFrame: data.seekFrame,
        };
    });
}

function parseVec(value: string | undefined, label: string): [number, number, number] {
    const parts = value?.split(",").map(Number) ?? [];
    expect(parts, `${label} should contain three comma-separated numbers`).toHaveLength(3);
    for (const part of parts) {
        expect(Number.isFinite(part), `${label} values should be finite`).toBe(true);
    }
    return [parts[0]!, parts[1]!, parts[2]!];
}

function expectVecClose(actual: [number, number, number], expected: [number, number, number], tolerance: number, label: string): void {
    for (let i = 0; i < 3; i++) {
        expect(Math.abs(actual[i] - expected[i]), `${label}[${i}]`).toBeLessThanOrEqual(tolerance);
    }
}

function expectMarkerState(state: PickState, label: string): void {
    expect(state.pickedHit, `${label} should hit the Alien`).not.toBe("miss");
    expect(state.markerPlaced, `${label} surface marker should be placed`).toBe("true");
    expect(state.normalMarkerPlaced, `${label} normal marker should be placed`).toBe("true");
    expect(state.normalMarkerAligned, `${label} normal marker should align to picked normal`).toBe("true");
    expect(state.markerNearPick, `${label} surface marker should be at picked point`).toBe("true");
    expect(state.normalMarkerNearPick, `${label} normal marker should be near picked point`).toBe("true");
    expect(Number(state.pickFaceId), `${label} face id should be available`).toBeGreaterThanOrEqual(0);
    expect(Number(state.pickSubMeshFaceId), `${label} submesh face id should be available`).toBeGreaterThanOrEqual(0);
    expect(Number(state.pickSubMeshId), `${label} submesh id should be available`).toBeGreaterThanOrEqual(0);
    expect(Number(state.seekFrame), `${label} should seek to frame 100`).toBeCloseTo(100, 8);
}

async function readBjsPickState(browser: Browser): Promise<PickState> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await context.newPage();
    try {
        await bjsPage.goto(`/babylon-ref-scene${SCENE_ID}.html?seekTime=${SEEK_TIME}`);
        return await readPickState(bjsPage);
    } finally {
        await bjsPage.close();
        await context.close();
    }
}

function expectPickInfoClose(liteState: PickState, bjsState: PickState): void {
    expect(liteState.pickCss).toBe(bjsState.pickCss);
    expect(Number(liteState.pickFaceId)).toBe(Number(bjsState.pickSubMeshFaceId));
    expectVecClose(parseVec(liteState.pickPoint, "Lite picked point"), parseVec(bjsState.pickPoint, "BJS picked point"), 0.002, "picked point");
    expectVecClose(parseVec(liteState.pickNormal, "Lite picked normal"), parseVec(bjsState.pickNormal, "BJS picked normal"), 0.002, "picked normal");
    expect(Number(liteState.pickDistance)).toBeCloseTo(Number(bjsState.pickDistance), 3);
    expect(Number(liteState.pickBu)).toBeCloseTo(Number(bjsState.pickBu), 3);
    expect(Number(liteState.pickBv)).toBeCloseTo(Number(bjsState.pickBv), 3);
}

test("Scene 115 - Alien precise picking at frame 100 matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: SCENE_ID, seekTime: SEEK_TIME, force: true, timeout: 120_000, settleMs: 1_000 });
    const bjsState = await readBjsPickState(browser);
    expectMarkerState(bjsState, "Babylon.js");

    await page.goto(`/scene${SCENE_ID}.html?seekTime=${SEEK_TIME}`);
    const liteState = await readPickState(page);
    expectMarkerState(liteState, "Lite");
    expectPickInfoClose(liteState, bjsState);

    await page.waitForTimeout(500);
    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, within-5=${((100 * full.within5) / full.totalPixels).toFixed(1)}%`);

    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
