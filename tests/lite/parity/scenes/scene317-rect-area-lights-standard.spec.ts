import { expect, test } from "../parity-fixtures";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { attachCompareArtifacts, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(317);
const referenceDir = path.resolve(__dirname, "../../../../reference/lite/scene317-rect-area-lights-standard");
const goldenRef = path.join(referenceDir, "babylon-ref-golden.png");

test("Scene 317 — upstream RectAreaLight Standard matches immutable Babylon.js golden", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    expect(existsSync(goldenRef), "Capture and commit the new BJS golden before running parity").toBe(true);
    await page.goto("/scene317.html");
    await waitForCanvasReady(page, { timeout: 60_000, label: "Scene 317 Lite" });
    await expect(page.locator("canvas")).toHaveAttribute("data-ltc-ready", "true");
    await page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 });

    const actual = path.join(referenceDir, "test-actual.png");
    await page.locator("canvas").screenshot({ path: actual });
    const result = compareImages(actual, goldenRef);
    await attachCompareArtifacts(testInfo, actual, goldenRef, referenceDir);
    expect(result.mad, `Full-image MAD must be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
