/**
 * Scene 53 — Depth-Hosted Sprites Mixed With 3D Parity Test (Lite-self golden)
 *
 * No BJS oracle: BJS's SpriteRenderer doesn't expose a screen-space pixel
 * coord layer with a fixed NDC.z value, so a comparable BJS scene would be
 * an arbitrary approximation rather than a real oracle. Instead this test
 * compares the current Lite render against a committed Lite-self golden —
 * i.e. it is a regression detector, not a cross-renderer parity check.
 *
 * Workflow for first-time golden commits / intentional re-captures:
 *   1. Run `pnpm dev:lab` and open `/scene53.html`
 *   2. Capture the canvas at the same viewport (1280x720) and save to
 *      `reference/scene53-depth-hosted-sprites/babylon-ref-golden.png`
 *   3. `git add` the file and re-run `pnpm test`
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(53);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene53-depth-hosted-sprites");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 53 skipped via skipParity in scene-config.json");

test("Scene 53 — Depth-hosted sprites mixed with 3D matches Lite-self golden", async ({ page }, testInfo) => {
    test.skip(!fs.existsSync(GOLDEN_REF), `Lite-self golden not committed yet at ${GOLDEN_REF}. Capture and commit it (see file header).`);

    await page.goto("/scene53.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);

    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
