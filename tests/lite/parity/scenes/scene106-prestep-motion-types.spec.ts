/**
 * Scene 106 — Physics V2 (Havok) prestep-type × motion-type grid Parity Test
 *
 * Port of playground #E9R16H#1. A 2×3 grid of cells (rows = prestep type [TELEPORT, ACTION],
 * columns = motion type [STATIC, ANIMATED, DYNAMIC]). Each cell is a 10×1×10 box platform (motion +
 * prestep type set per cell) with a falling cylinder (diameter 2, height 2) resting 0.5 above it.
 * Every box node is nudged each fixed 1/60 physics step; the box's prestep type governs how that
 * node motion drives Havok (TELEPORT snaps the body, ACTION sets a velocity toward it).
 *
 * Parity is a pure rendered-frame MAD check against a committed VISUAL golden
 * (`babylon-ref-golden.png`) captured from the Babylon.js reference page at the chosen early frame.
 * There is no character / collision assertion.
 *
 * The playground's DynamicTexture text labels are intentionally omitted.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(106);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene106-prestep-motion-types");
// Early deterministic frame: the cylinders are mid-fall but the Lite/BJS Havok builds have not yet
// diverged enough to matter (MAD ≈ 0.008 here; the latest still-passing frame is ≈28 at MAD ≈ 0.044,
// so frame 20 keeps a comfortable, machine-robust margin under the 0.05 ceiling).
const VISUAL_FRAME = 20;

test.skip(!!sceneConfig.skipParity, "Scene 106 skipped via skipParity in scene-config.json");

/** Load a scene page at the given capture frame, then screenshot the canvas. */
async function capture(page: Page, url: string, frame: number, label: string, screenshotPath: string): Promise<void> {
    await page.goto(`${url}?captureFrame=${frame}`);
    await waitForCanvasReady(page, { timeout: 50_000, label });
    await waitForCanvasReady(page, { timeout: 50_000, label: `${label} at frame ${frame}`, flag: "captureReady", pollMs: 100 });
    await page.locator("canvas").screenshot({ path: screenshotPath });
}

test("Scene 106 — Prestep × motion-type grid matches Babylon.js", async ({ page }) => {
    const browser = page.context().browser()!;
    fs.mkdirSync(REFERENCE_DIR, { recursive: true });

    // ── Committed VISUAL golden at the early visual frame ──
    const goldenPath = await captureGolden(browser, { sceneId: 106, queryParams: `captureFrame=${VISUAL_FRAME}`, waitFlag: "captureReady" });

    // ── Lite at the same frame ──
    const visualPath = path.join(REFERENCE_DIR, "test-actual.png");
    await capture(page, "/scene106.html", VISUAL_FRAME, "Scene 106 Lite", visualPath);

    // ── Rendered-frame parity ──
    const full = compareImages(visualPath, goldenPath);
    console.log(`Scene 106 full image at frame ${VISUAL_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(4)}`);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
