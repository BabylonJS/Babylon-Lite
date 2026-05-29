/**
 * Scene 202 — LWR Side-by-Side Parity Test
 *
 * Renders the side-by-side LWR demo scene (HPM on; left half uses
 * `useFloatingOrigin: false`, right half uses `true`) and asserts the
 * captured frame matches the committed golden. Both halves render
 * identical geometry at world OFFSET = 5e6; the right half stays crisp
 * while the left half exhibits visible F32 jitter on cube/pillar edges.
 *
 * The MAD ceiling is permissive (5.0) for the same reason as scene 200:
 * the F32 path's edge anti-aliasing rounds differently across GPUs while
 * silhouettes stay stable. The HPM-on right half is bit-deterministic.
 *
 * Companion divergence assertions live in
 * `tests/unit/hpm-divergence.test.ts` (left-half vs right-half MAD on
 * the same image, plus non-blank guards).
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(202);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene202-lwr-side-by-side");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 202 skipped via skipParity in scene-config.json");

test("Scene 202 — LWR side-by-side matches committed golden", async ({ page }, testInfo) => {
    await page.goto("/scene202.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    if (!fs.existsSync(GOLDEN_REF) || process.env.BABYLON_LITE_CAPTURE_HPM_GOLDEN === "1") {
        fs.copyFileSync(screenshotPath, GOLDEN_REF);

        console.log(`Captured initial golden -> ${GOLDEN_REF}`);
    }

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Scene 202 full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `LWR side-by-side full-image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
