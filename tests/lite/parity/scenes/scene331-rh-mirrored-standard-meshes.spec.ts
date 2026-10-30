/**
 * Scene 331 — Mirrored StandardMaterial meshes (right-handed twin of scene 270).
 *
 * Same Lite code as scene 270, built right-handed; the golden is the Babylon.js
 * reference with `useRightHandedSystem = true`.
 *
 * A mirrored world transform reverses triangle winding, so the pipeline's `frontFace` has to flip
 * or the mesh renders inside-out. Lite's Standard pipeline had no winding reversal at all (only the
 * glTF/PBR path did), and neither path re-evaluated the winding when a transform changed at runtime.
 *
 * The four boxes cover: not mirrored, mirrored before build, mirrored at runtime, and mirrored by an
 * ancestor at runtime. Babylon derives `sideOrientation` from the world determinant, so it is the
 * reference for all four.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(331);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene331-rh-mirrored-standard-meshes");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 331 skipped via skipParity in scene-config.json");

test("Scene 331 — mirrored Standard meshes match right-handed Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 331, force: true });

    await page.goto("/scene331.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(100);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD: ${full.mad.toFixed(3)} (limit ${sceneConfig.maxMad})`);
    expect(full.mad, `Full image MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
