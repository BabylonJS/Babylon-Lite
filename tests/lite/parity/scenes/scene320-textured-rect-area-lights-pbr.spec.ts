import { expect, test } from "../parity-fixtures";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(320);
const referenceDir = path.resolve(__dirname, "../../../../reference/lite/scene320-textured-rect-area-lights-pbr");
const goldenRef = path.join(referenceDir, "babylon-ref-golden.png");

test("Scene 320 — upstream textured RectAreaLight PBR matches immutable Babylon.js golden", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    expect(existsSync(goldenRef), "Capture and commit the new BJS golden before running parity").toBe(true);
    await page.goto("/scene320.html");
    await waitForCanvasReady(page, { timeout: 90_000, label: "Scene 320 Lite" });
    await expect(page.locator("canvas")).toHaveAttribute("data-emission-ready", "true");
    await expect(page.locator("canvas")).toHaveAttribute("data-ltc-ready", "true");
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const actual = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, goldenRef);
    await attachCompareArtifacts(testInfo, actual, goldenRef, referenceDir);
    expect(result.mad, `Full-image MAD must be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
