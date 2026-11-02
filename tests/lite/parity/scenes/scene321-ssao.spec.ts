import { expect, test } from "../parity-fixtures";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(321);
const referenceDir = path.resolve(__dirname, "../../../../reference/lite/scene321-ssao");
const goldenRef = path.join(referenceDir, "babylon-ref-golden.png");

// Kitchen lit by the environment only. Lite (Half-pipeline, medium-quality temporally filtered XeGTAO on PBR diffuse IBL, frozen after a
// fixed frame count) and Babylon.js (SSAO2 multiplying the final color) use different
// AO algorithms; the wider MAD ceiling bounds lighting, geometry and overall occlusion placement.
test("Scene 321 — screen-space ambient occlusion stays close to the Babylon.js SSAO2 golden", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    expect(existsSync(goldenRef), "Capture and commit the new BJS golden before running parity").toBe(true);
    await page.goto("/scene321.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 321 Lite" });
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const actual = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, goldenRef);
    await attachCompareArtifacts(testInfo, actual, goldenRef, referenceDir);
    expect(result.mad, `Full-image MAD must be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
