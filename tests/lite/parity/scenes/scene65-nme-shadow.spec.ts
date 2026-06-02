/**
 * Scene 65 — NME Shadow Receive Parity Test
 *
 * Both BJS and Lite share the scene 63 NME JSON. Lite passes the
 * ShadowGenerator into `parseNodeMaterialFromSnippet({ shadowGenerators })`,
 * BJS uses a classic ShadowGenerator on the DirectionalLight — the LightBlock
 * in the NME graph auto-applies the shadow factor in both engines.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(65);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene65-nme-shadow");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 65 skipped via skipParity in scene-config.json");

test("Scene 65 — NME shadow receive matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 65 });

    await page.goto("/scene65.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
