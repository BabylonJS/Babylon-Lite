/**
 * Scene 269 — setParent() on a mirrored glTF root.
 *
 * The glTF loader's synthetic `__root__` carries the RH→LH handedness flip as a negative scale,
 * giving its local transform a negative determinant. Reparenting it with `setParent()` rebuilds
 * the local TRS from `inverse(parentWorld) * childWorld`; a decomposition that returns only
 * non-negative scales drops the reflection and renders the model mirrored (forum topic 63859).
 *
 * Babylon.js `TransformNode.setParent()` folds the reflection onto a negative Y scale, so this
 * scene pins Lite's `mat4Decompose` to that same behaviour.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(269);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene269-setparent-mirrored-root");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 269 skipped via skipParity in scene-config.json");

test("Scene 269 — setParent on a mirrored glTF root matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 269 });

    await page.goto("/scene269.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(100);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
