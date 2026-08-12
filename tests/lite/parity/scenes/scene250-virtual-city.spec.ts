/**
 * Scene 250 — VirtualCity (cx20 gltf-test parity).
 *
 * cx20's compat matrix (https://github.com/cx20/gltf-test#format-tests) flags the
 * Babylon Lite column for this model with ":warning: embedded camera": Lite's
 * loadGltf() only ever exposed a single scene camera and never parsed the glTF
 * `camera` node property. The `_gltf_camera` loader feature closes that gap: this
 * scene selects the imported camera named `camera6` (glTF camera index 6,
 * node 116 — an animated
 * flying-vehicle chase camera) as `scene.camera`, so parity actually exercises the
 * feature and would fail without it. The animation is frozen at `seekTime=5.0` for
 * a deterministic golden (GUIDANCE §2c).
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(250);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene250-virtual-city");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const SEEK_TIME = 5.0;

test.skip(!!sceneConfig.skipParity, "Scene 250 skipped via skipParity in scene-config.json");

test("Scene 250 — VirtualCity matches Babylon.js reference", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 250, seekTime: SEEK_TIME, timeout: 90_000 });

    await page.goto(`/scene250.html?seekTime=${SEEK_TIME}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.animationFrozen === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
