/**
 * Scene 66 — NME Full Playground (AT7YY5#6) Parity Test
 *
 * The 136-block NME graph exercises the full runtime: diffuse/ambient/
 * specular/emissive/normal/opacity/lightmap textures + equirect reflection,
 * skinning, instances, morph targets, fog, discard, PCF shadow receive,
 * front-facing, and the lighting dispatcher. Both pages use checked-in local
 * NME data with extracted local texture assets.
 *
 * Morph scramble deltas come from a shared deterministic mulberry32 seed
 * and weight is pinned via `?freeze=1` for capture reproducibility.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(66);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene66-nme-big");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 66 skipped via skipParity in scene-config.json");

test("Scene 66 — NME full playground matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 66, queryParams: "freeze=1", timeout: 120_000 });

    await page.goto("/scene66.html?freeze=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
