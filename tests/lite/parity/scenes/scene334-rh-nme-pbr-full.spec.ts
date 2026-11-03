// Right-handed twin of scene72-nme-pbr-full.spec.ts: the same checks against the Babylon.js reference with useRightHandedSystem = true.
/**
 * Scene 334 — Full D8AK3Z PBR-NME Parity Test
 *
 * Uses checked-in EPY8BV#6 NME data (the full PBR-MR + Reflection + ClearCoat
 * + Sheen + Anisotropy + SubSurface NME graph from playground D8AK3Z#160)
 * and runs it through both BJS NodeMaterial.Parse and Lite's NME parser.
 *
 * This is the full visual parity coverage scene for the PBR-MR NME stack.
 */
import { test, expect } from "../parity-fixtures";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(334);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene334-rh-nme-pbr-full");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test.skip(!!sceneConfig.skipParity, "Scene 334 skipped via skipParity in scene-config.json");

test("Scene 334 — NME PBR Full (D8AK3Z) matches Babylon.js reference (right-handed)", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 334 });

    await page.goto("/scene334.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
